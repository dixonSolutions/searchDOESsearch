#!/usr/bin/env -S gjs -m
/**
 * check-resource-imports.js — do the shell resources we import actually exist?
 *
 * A wrong `resource:///` path is invisible to tsc, to `make pack`, and to every
 * test that does not start the process the file runs in. It shipped once: prefs
 * imported `resource:///org/gnome/shell/extensions/prefs.js`, which the Shell
 * has never had — the real path is capitalised and nested under js/ — so the
 * settings window failed with an ImportError for everyone.
 *
 * The Shell's own JS (`ui/main.js`, `extensions/extension.js`) lives inside the
 * running gnome-shell process and cannot be looked up from outside it; that side
 * is covered by scripts/nested-test.sh, which fails if the extension does not
 * reach ACTIVE. The *preferences* resources are different: they ship as an
 * installed gresource bundle, so they can be checked here, and that is precisely
 * where the bug was.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import system from 'system';

const SHELL_DATA = '/usr/share/gnome-shell';
// Paths the Shell only exposes to code running inside it.
const SHELL_PROCESS_ONLY = /^\/org\/gnome\/shell\/(ui|misc|extensions\/extension\.js)/;

function registerInstalledBundles() {
    let count = 0;
    const dir = Gio.File.new_for_path(SHELL_DATA);
    if (!dir.query_exists(null))
        return count;
    const children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = children.next_file(null))) {
        const name = info.get_name();
        if (!name.endsWith('.gresource'))
            continue;
        try {
            Gio.Resource.load(GLib.build_filenamev([SHELL_DATA, name]))._register();
            count++;
        } catch (e) {
            // A bundle we cannot load tells us nothing; the checks below still stand.
        }
    }
    return count;
}

function sourceFiles() {
    const files = [];
    for (const dir of ['src', 'panel']) {
        const d = Gio.File.new_for_path(dir);
        if (!d.query_exists(null))
            continue;
        const children = d.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = children.next_file(null))) {
            const name = info.get_name();
            if (name.endsWith('.ts') || name.endsWith('.js'))
                files.push(GLib.build_filenamev([dir, name]));
        }
    }
    return files;
}

const bundles = registerInstalledBundles();
print(`check-resource-imports: ${bundles} gresource bundle(s) registered`);

let failures = 0, checked = 0, skipped = 0;
for (const file of sourceFiles()) {
    const [, bytes] = GLib.file_get_contents(file);
    const text = new TextDecoder().decode(bytes);
    for (const match of text.matchAll(/resource:\/\/(\/[^'"`\s]+)/g)) {
        const path = match[1];
        if (SHELL_PROCESS_ONLY.test(path)) {
            print(`  ~ ${path}  (${file}: only resolvable inside gnome-shell — covered by nested-test.sh)`);
            skipped++;
            continue;
        }
        checked++;
        try {
            Gio.resources_get_info(path, Gio.ResourceLookupFlags.NONE);
            print(`  ✓ ${path}  (${file})`);
        } catch (e) {
            print(`  ✗ ${path}  (${file}) — no such resource on this system`);
            failures++;
        }
    }
}

print(`check-resource-imports: ${checked} checked, ${skipped} deferred to the nested session, ${failures} broken`);
if (failures > 0)
    system.exit(1);
