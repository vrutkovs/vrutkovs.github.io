const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

/* jsonutil.js:
 * Read/write JSON to/from GFile paths, very inefficiently.
 */

function writeJsonFileAtomic(path, data, cancellable) {
    let buf = JSON.stringify(data, null, "  ");
    let s = path.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
    s.write_bytes(new GLib.Bytes(buf), cancellable);
    s.close(cancellable);
}

function loadJson(path, cancellable) {
    let [success,contents,etag] = path.load_contents(cancellable);
    return JSON.parse(contents);
}

