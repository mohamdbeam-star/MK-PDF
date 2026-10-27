package com.mkoussa.mkpdf;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Updates from GitHub Releases: downloads the new APK and hands it to Android's installer, which installs it over
 * this app (same signing key, so nothing to uninstall). Also posts the "new version" notification.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {
    private static final String CHANNEL = "updates";

    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.matches("^https://(github\\.com|objects\\.githubusercontent\\.com|release-assets\\.githubusercontent\\.com)/.*")) {
            call.reject("Unexpected update location");
            return;
        }
        Context context = getContext();
        // Android asks once to let MK PDF install apps; after that, tapping Install again goes straight through.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.getPackageManager().canRequestPackageInstalls()) {
            Intent allow = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()));
            allow.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(allow);
            call.reject("Allow MK PDF to install updates, then tap Install again.", "PERMISSION");
            return;
        }
        new Thread(() -> {
            try {
                File dir = new File(context.getCacheDir(), "updates");
                dir.mkdirs();
                for (File old : dir.listFiles() == null ? new File[0] : dir.listFiles()) old.delete();
                File apk = new File(dir, "MK-PDF-update.apk");
                download(url, apk);
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);
                call.resolve();
            } catch (Exception e) {
                call.reject("Download failed: " + e.getMessage());
            }
        }).start();
    }

    private static void download(String address, File target) throws Exception {
        // GitHub answers with redirects to its download host.
        for (int hops = 0; hops < 6; hops++) {
            HttpURLConnection c = (HttpURLConnection) new URL(address).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent", "MK-PDF");
            int status = c.getResponseCode();
            if (status >= 300 && status < 400) { address = c.getHeaderField("Location"); c.disconnect(); continue; }
            if (status != 200) throw new Exception("HTTP " + status);
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(target)) {
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            }
            return;
        }
        throw new Exception("too many redirects");
    }

    @PluginMethod
    public void notify(PluginCall call) {
        Context context = getContext();
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7101);
            call.resolve();
            return;
        }
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Updates", NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder n = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(call.getString("title", "MK PDF"))
            .setContentText(call.getString("body", ""))
            .setContentIntent(tap)
            .setAutoCancel(true);
        manager.notify(7100, n.build());
        call.resolve();
    }
}
