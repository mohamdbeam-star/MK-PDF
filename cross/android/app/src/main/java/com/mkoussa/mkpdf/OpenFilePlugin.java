package com.mkoussa.mkpdf;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;

/** Delivers opened files to the web app as "open" events, holding them until the app is listening. */
@CapacitorPlugin(name = "OpenFile")
public class OpenFilePlugin extends Plugin {
    private static final List<JSObject> waiting = new ArrayList<>();
    private static OpenFilePlugin instance;

    @Override
    public void load() {
        synchronized (waiting) {
            instance = this;
            for (JSObject f : waiting) notifyListeners("open", f, true);
            waiting.clear();
        }
    }

    static void offer(JSObject file) {
        synchronized (waiting) {
            // Retained events are delivered as soon as the web app adds its listener.
            if (instance != null) instance.notifyListeners("open", file, true);
            else waiting.add(file);
        }
    }
}
