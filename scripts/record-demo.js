#!/usr/bin/env -S gjs -m
// Hold the screencast open for a fixed span.
//
// org.gnome.Shell.Screencast stops the moment the client that asked for it
// drops off the bus, so `gdbus call` yields exactly one frame and a
// "Sender has vanished" error. A running main loop keeps this connection up for
// the whole recording, and stops it deliberately at the end.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import system from 'system';

const [out, secs] = system.programArgs;

const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
const proxy = Gio.DBusProxy.new_sync(
    bus, Gio.DBusProxyFlags.NONE, null,
    'org.gnome.Shell.Screencast', '/org/gnome/Shell/Screencast',
    'org.gnome.Shell.Screencast', null);

// The options dict goes in as a plain object: handing GJS an already-built
// a{sv} Variant here makes it try to pack that Variant's own methods.
const [ok, path] = proxy.call_sync(
    'Screencast', new GLib.Variant('(sa{sv})', [out, {
        'draw-cursor': new GLib.Variant('b', true),
        'framerate': new GLib.Variant('i', 30),
    }]),
    Gio.DBusCallFlags.NONE, -1, null).deepUnpack();

print(`[record] started=${ok} path=${path}`);
if (!ok)
    system.exit(1);

const loop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(Number(secs) * 1000), () => {
    proxy.call_sync('StopScreencast', null, Gio.DBusCallFlags.NONE, -1, null);
    print('[record] stopped');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
