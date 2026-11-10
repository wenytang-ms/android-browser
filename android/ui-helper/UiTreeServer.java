package com.tango.uitree;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Point;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.lang.reflect.InvocationTargetException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Timer;
import java.util.TimerTask;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

public final class UiTreeServer {
    private static final int MAX_NODES = 2000;
    private static final int MAX_DEPTH = 64;
    private static final int MAX_BYTES = 900000;
    private static final int VERSION = 2;
    private static final int ACTION_TTL_MS = 30000;
    private static final String[] ACTION_NAMES = {
        "click", "longClick", "setText", "scrollForward", "scrollBackward",
        "scrollUp", "scrollDown", "scrollLeft", "scrollRight"
    };
    private static final int[] ACTION_IDS = {
        AccessibilityNodeInfo.ACTION_CLICK, AccessibilityNodeInfo.ACTION_LONG_CLICK,
        AccessibilityNodeInfo.ACTION_SET_TEXT, AccessibilityNodeInfo.ACTION_SCROLL_FORWARD,
        AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD,
        AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.getId(),
        AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.getId(),
        AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.getId(),
        AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.getId()
    };
    private static final Object CACHE_LOCK = new Object();
    private static final Timer expiry = new Timer("TangoUiExpiry", true);
    private static Snapshot current;
    private static UiAutomation automation;
    private static HandlerThread callbacks;

    private static final class Failure extends Exception {
        final String code;
        Failure(String code, String message) { super(message); this.code = code; }
    }

    public static void main(String[] args) {
        PrintWriter output = new PrintWriter(System.out, true);
        try {
            if (Build.VERSION.SDK_INT < 24) throw new Failure("UNSUPPORTED", "UI tree helper requires Android 7 or newer.");
            if (Looper.getMainLooper() == null) Looper.prepareMainLooper();
            callbacks = new HandlerThread("TangoUiCallbacks");
            callbacks.start();
            Class<?> connectionType = Class.forName("android.app.IUiAutomationConnection");
            Object connection = Class.forName("android.app.UiAutomationConnection").getConstructor().newInstance();
            automation = (UiAutomation) UiAutomation.class
                .getConstructor(Looper.class, connectionType).newInstance(callbacks.getLooper(), connection);
            UiAutomation.class.getMethod("connect", int.class).invoke(automation, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            AccessibilityServiceInfo info = automation.getServiceInfo();
            info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            automation.setServiceInfo(info);
            output.println(new JSONObject().put("v", VERSION).put("type", "ready").put("helperVersion", VERSION));
            BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            String line;
            int previousId = 0;
            while ((line = readLine(input)) != null) {
                int id = 0;
                try {
                    JSONObject request = new JSONObject(line);
                    id = request.getInt("id");
                    if (request.getInt("v") != VERSION || id <= previousId || line.getBytes(StandardCharsets.UTF_8).length > 8192)
                        throw new Failure("BAD_REQUEST", "Invalid protocol, request sequence or request size.");
                    previousId = id;
                    String method = request.getString("method");
                    JSONObject response = new JSONObject().put("v", VERSION).put("id", id).put("type", method);
                    if ("snapshot".equals(method)) response.put("snapshot", snapshot(id));
                    else if ("action".equals(method)) response.put("result", action(request.getJSONObject("request")));
                    else throw new Failure("BAD_REQUEST", "Only snapshot and node action requests are supported.");
                    output.println(response);
                } catch (Exception error) {
                    output.println(error(id, error));
                }
            }
        } catch (Throwable error) {
            output.println(error(0, error));
        } finally {
            clearSnapshot();
            expiry.cancel();
            if (automation != null) {
                try { UiAutomation.class.getMethod("disconnect").invoke(automation); }
                catch (Exception error) { System.err.println("UI tree helper disconnect failed: " + error.getClass().getSimpleName()); }
            }
            if (callbacks != null) callbacks.quitSafely();
        }
        System.exit(0);
    }

    private static String readLine(BufferedReader input) throws Exception {
        StringBuilder line = new StringBuilder();
        int value;
        while ((value = input.read()) != -1) {
            if (value == '\n') return line.toString();
            if (line.length() >= 8192) throw new Failure("BAD_REQUEST", "Request is too large.");
            line.append((char) value);
        }
        return line.length() == 0 ? null : line.toString();
    }

    private static JSONObject error(int id, Throwable error) {
        while (error instanceof InvocationTargetException && error.getCause() != null) error = error.getCause();
        String code = error instanceof Failure ? ((Failure) error).code : "HELPER_FAILURE";
        String message = error instanceof Failure ? error.getMessage()
            : "Android UI automation failed (" + error.getClass().getSimpleName() + "). Check ROM support and competing UI automation tools.";
        try { return new JSONObject().put("v", VERSION).put("type", "error").put("id", id).put("code", code).put("message", message); }
        catch (Exception impossible) { throw new IllegalStateException(impossible); }
    }

    private static Display display() throws Exception {
        Class<?> type = Class.forName("android.hardware.display.DisplayManagerGlobal");
        Object manager = type.getMethod("getInstance").invoke(null);
        Display display = (Display) type.getMethod("getRealDisplay", int.class).invoke(manager, 0);
        if (display == null) throw new Failure("DISPLAY_UNAVAILABLE", "Default display is unavailable.");
        return display;
    }

    private static JSONObject snapshot(int id) throws Exception {
        clearSnapshot();
        long start = SystemClock.elapsedRealtime();
        Display display = display();
        Point size = new Point();
        display.getRealSize(size);
        int rotation = display.getRotation();
        if (Build.VERSION.SDK_INT >= 34 && !automation.clearCache())
            throw new Failure("CACHE_UNAVAILABLE", "Accessibility cache could not be cleared. Retry.");
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        if (root == null) throw new Failure("ROOT_UNAVAILABLE", "Active window has no accessible root. Unlock the phone or wait for the UI, then retry.");
        Tree tree = new Tree(start + 5000);
        boolean retained = false;
        try {
            checkDisplay(root);
            tree.visit(root, -1, 0);
            Point after = new Point();
            Display latest = display();
            latest.getRealSize(after);
            if (!size.equals(after) || rotation != latest.getRotation())
                throw new Failure("DISPLAY_CHANGED", "Display changed while reading UI tree. Retry.");
            final Snapshot state = new Snapshot(tree, size, rotation, start + ACTION_TTL_MS);
            long remaining = Math.max(0, state.expires - SystemClock.elapsedRealtime());
            JSONObject result = new JSONObject().put("snapshotId", id).put("snapshotRef", state.ref)
                .put("expiresInMs", remaining).put("capturedAtMs", start)
                .put("durationMs", SystemClock.elapsedRealtime() - start)
                .put("display", new JSONObject().put("id", 0).put("width", size.x).put("height", size.y).put("rotation", rotation))
                .put("nodes", tree.nodes).put("truncated", tree.truncated);
            synchronized (CACHE_LOCK) {
                current = state;
                state.expiration = new TimerTask() {
                    public void run() {
                        synchronized (CACHE_LOCK) { if (current == state) clearSnapshot(); }
                    }
                };
                expiry.schedule(state.expiration, remaining);
                retained = true;
            }
            return result;
        } finally {
            root.recycle();
            if (!retained) tree.recycle();
        }
    }

    private static void checkDisplay(AccessibilityNodeInfo root) throws Exception {
        if (Build.VERSION.SDK_INT < 30) return;
        AccessibilityWindowInfo window = root.getWindow();
        if (window == null) throw new Failure("DISPLAY_UNAVAILABLE", "Active window display is unavailable.");
        try {
            if (window.getDisplayId() != 0) throw new Failure("UNSUPPORTED_DISPLAY", "Only the default display is supported.");
        } finally { window.recycle(); }
    }

    private static void clearSnapshot() {
        synchronized (CACHE_LOCK) {
            if (current != null) {
                if (current.expiration != null) current.expiration.cancel();
                expiry.purge();
                current.tree.recycle();
                current = null;
            }
        }
    }

    private static final class Snapshot {
        final String ref = UUID.randomUUID().toString();
        final Tree tree;
        final Point size;
        final int rotation;
        final long expires;
        TimerTask expiration;
        Snapshot(Tree tree, Point size, int rotation, long expires) {
            this.tree = tree; this.size = size; this.rotation = rotation; this.expires = expires;
        }
    }

    private static final class NodeRef {
        final AccessibilityNodeInfo node;
        final int id;
        final int parent;
        final int children;
        final String fingerprint;
        NodeRef(AccessibilityNodeInfo node, int id, int parent, String fingerprint) {
            this.node = node; this.id = id; this.parent = parent;
            this.children = node.getChildCount(); this.fingerprint = fingerprint;
        }
        boolean matches(AccessibilityNodeInfo fresh) throws Exception {
            return children == fresh.getChildCount() && fingerprint.equals(new Tree(0).describe(fresh, id, parent).toString());
        }
    }

    private static boolean supports(AccessibilityNodeInfo node, int id) {
        for (AccessibilityNodeInfo.AccessibilityAction action : node.getActionList())
            if (action.getId() == id) return true;
        return false;
    }

    private static JSONObject action(JSONObject request) throws Exception {
        String ref = request.getString("snapshotRef");
        int nodeId = request.getInt("nodeId");
        String name = request.getString("action");
        int actionId = 0;
        for (int index = 0; index < ACTION_NAMES.length; ++index)
            if (ACTION_NAMES[index].equals(name)) actionId = ACTION_IDS[index];
        if (actionId == 0) throw new Failure("UNSUPPORTED_ACTION", "Only advertised standard node actions are allowed.");
        Bundle arguments = null;
        if ("setText".equals(name)) {
            Object value = request.get("text");
            if (!(value instanceof String) || ((String) value).getBytes(StandardCharsets.UTF_8).length > 1024)
                throw new Failure("BAD_REQUEST", "Text must be a string of at most 1024 UTF-8 bytes.");
            arguments = new Bundle();
            arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, (String) value);
        } else if (request.has("text")) throw new Failure("BAD_REQUEST", "Text is accepted only for setText.");
        Snapshot state;
        synchronized (CACHE_LOCK) {
            if (current == null || !current.ref.equals(ref) || SystemClock.elapsedRealtime() >= current.expires)
                throw new Failure("STALE_SNAPSHOT", "Snapshot expired or was consumed. Read a fresh tree.");
            state = current;
            current = null;
            state.expiration.cancel();
            expiry.purge();
        }
        try {
            if (nodeId < 0 || nodeId >= state.tree.refs.size()) throw new Failure("STALE_NODE", "Node is not in this snapshot.");
            Point size = new Point();
            Display display = display();
            display.getRealSize(size);
            if (!state.size.equals(size) || state.rotation != display.getRotation())
                throw new Failure("DISPLAY_CHANGED", "Display changed. Read a fresh tree.");
            AccessibilityNodeInfo root = automation.getRootInActiveWindow();
            if (root == null) throw new Failure("ROOT_UNAVAILABLE", "Active root is unavailable. Read a fresh tree.");
            try {
                checkDisplay(root);
                NodeRef previousRoot = state.tree.refs.get(0);
                if (!root.refresh() || !root.equals(previousRoot.node) || !previousRoot.matches(root))
                    throw new Failure("WINDOW_CHANGED", "Active window changed. Read a fresh tree.");
            } finally { root.recycle(); }
            NodeRef target = state.tree.refs.get(nodeId);
            if (!target.node.refresh() || !target.matches(target.node))
                throw new Failure("STALE_NODE", "Node changed or disappeared. Read a fresh tree.");
            if (!target.node.isEnabled() || !target.node.isVisibleToUser())
                throw new Failure("NODE_UNAVAILABLE", "Node is disabled or not visible.");
            if (!supports(target.node, actionId)) throw new Failure("UNSUPPORTED_ACTION", "Node does not advertise this action.");
            if (SystemClock.elapsedRealtime() >= state.expires) throw new Failure("STALE_SNAPSHOT", "Snapshot expired before execution.");
            if (!target.node.performAction(actionId, arguments))
                throw new Failure("ACTION_REJECTED", "Android did not handle the action. Read a fresh tree; no coordinate fallback was attempted.");
            return new JSONObject().put("snapshotRef", ref).put("nodeId", nodeId).put("action", name).put("accepted", true);
        } finally { state.tree.recycle(); }
    }

    private static final class Tree {
        final JSONArray nodes = new JSONArray();
        final List<NodeRef> refs = new ArrayList<NodeRef>();
        final long deadline;
        int bytes;
        boolean truncated;
        Tree(long deadline) { this.deadline = deadline; }
        String text(CharSequence text) {
            if (text == null) return "";
            if (text.length() > 1024) { truncated = true; return text.subSequence(0, 1024).toString(); }
            return text.toString();
        }
        JSONObject describe(AccessibilityNodeInfo node, int id, int parent) throws Exception {
            Rect bounds = new Rect();
            node.getBoundsInScreen(bounds);
            JSONArray actions = new JSONArray();
            for (int index = 0; index < ACTION_NAMES.length; ++index)
                if (supports(node, ACTION_IDS[index])) actions.put(ACTION_NAMES[index]);
            return new JSONObject().put("id", id).put("parentId", parent < 0 ? JSONObject.NULL : parent)
                .put("windowId", node.getWindowId()).put("resourceId", text(node.getViewIdResourceName()))
                .put("className", text(node.getClassName())).put("packageName", text(node.getPackageName()))
                .put("text", node.isPassword() ? "" : text(node.getText()))
                .put("description", node.isPassword() ? "" : text(node.getContentDescription()))
                .put("bounds", new JSONArray().put(bounds.left).put(bounds.top).put(bounds.right).put(bounds.bottom))
                .put("clickable", node.isClickable()).put("enabled", node.isEnabled()).put("visible", node.isVisibleToUser())
                .put("scrollable", node.isScrollable()).put("editable", node.isEditable()).put("focused", node.isFocused())
                .put("checkable", node.isCheckable()).put("checked", node.isChecked()).put("password", node.isPassword())
                .put("actions", actions);
        }
        void recycle() {
            for (NodeRef ref : refs) ref.node.recycle();
            refs.clear();
        }
        void visit(AccessibilityNodeInfo node, int parent, int depth) throws Exception {
            if (SystemClock.elapsedRealtime() > deadline) throw new Failure("TIMEOUT", "UI tree traversal timed out.");
            if (nodes.length() >= MAX_NODES || depth > MAX_DEPTH) { truncated = true; return; }
            if (!node.refresh()) throw new Failure("TREE_CHANGED", "UI node disappeared during capture. Retry.");
            int id = nodes.length();
            JSONObject item = describe(node, id, parent);
            bytes += item.toString().getBytes(StandardCharsets.UTF_8).length + 1;
            if (bytes > MAX_BYTES) { truncated = true; return; }
            nodes.put(item);
            refs.add(new NodeRef(AccessibilityNodeInfo.obtain(node), id, parent, item.toString()));
            int children = node.getChildCount();
            if (depth == MAX_DEPTH && children > 0) { truncated = true; return; }
            for (int index = 0; index < children; ++index) {
                if (SystemClock.elapsedRealtime() > deadline) throw new Failure("TIMEOUT", "UI tree traversal timed out.");
                if (nodes.length() >= MAX_NODES || bytes > MAX_BYTES) { truncated = true; break; }
                AccessibilityNodeInfo child = node.getChild(index);
                if (child == null) { truncated = true; continue; }
                try { visit(child, id, depth + 1); }
                finally { child.recycle(); }
            }
        }
    }
}
