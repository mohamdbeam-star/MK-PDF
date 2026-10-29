package com.mkoussa.mkpdf;

import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;

/** Read aloud: Android's web view has no speech synthesis, so the system text-to-speech engine reads instead. */
@CapacitorPlugin(name = "Speech")
public class SpeechPlugin extends Plugin {
    private TextToSpeech tts;
    private boolean ready = false;
    private PluginCall pending;

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> ready = status == TextToSpeech.SUCCESS);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) {}
            @Override public void onDone(String id) { if ("last".equals(id)) finish(); }
            @Override public void onError(String id) { finish(); }
            @Override public void onStop(String id, boolean interrupted) { finish(); }
        });
    }

    private synchronized void finish() {
        if (pending != null) { pending.resolve(); pending = null; }
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        if (!ready || text.isEmpty()) { call.reject("Reading aloud isn't available on this device."); return; }
        tts.stop();
        finish();
        pending = call;
        // Arabic text reads with an Arabic voice when the phone has one.
        tts.setLanguage(text.matches("(?s).*[\\u0600-\\u06FF].*") ? new Locale("ar") : Locale.getDefault());
        // The engine takes a few thousand characters at a time.
        int max = Math.max(500, TextToSpeech.getMaxSpeechInputLength() - 100);
        for (int i = 0; i < text.length(); i += max) {
            String part = text.substring(i, Math.min(text.length(), i + max));
            tts.speak(part, TextToSpeech.QUEUE_ADD, null, i + max >= text.length() ? "last" : "part" + i);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        tts.stop();
        finish();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
    }
}
