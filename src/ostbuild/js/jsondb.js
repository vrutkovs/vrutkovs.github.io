const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Format = imports.format;

const JsonUtil = imports.jsonutil;

const JsonDB = new Lang.Class({
    Name: 'JsonDB',

    _init: function(path, prefix) {
	this._path = path;
	this._prefix = prefix;
	this._re = /-(\d+)\.(\d+)-([0-9a-f]+).json$/;
    },

    parseVersion: function(basename) {
	let match = this._re.exec(basename);
	if (!match)
	    throw new Error("No JSONDB version in " + basename);
	return [parseInt(match[1]), parseInt(match[2])];
    },

    parseVersionStr: function(basename) {
	let [major, minor] = this.parseVersion(basename);
	return Format.vprintf('%d.%d', [major, minor]);
    },

    _getAll: function() {
	var result = [];
	var e = this._path.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
	let info;
	while ((info = e.next_file(null)) != null) {
	    let name = info.get_name();
	    if (name.indexOf(this._prefix) != 0)
		continue;
	    if (name.lastIndexOf('.json') != name.length-5)
		continue;
	    let match = this._re.exec(name);
	    if (!match)
		throw new Error("Invalid JSONDB file " + name);
	    result.push([parseInt(match[1]), parseInt(match[2]),
			 match[3], name]);
	}
	result.sort(function(a, b) {
	    var aMajor = a[0]; var bMajor = b[0];
	    var aMinor = a[1]; var bMinor = b[1];
	    if (aMajor < bMajor) return 1;
	    else if (aMajor > bMajor) return -1;
	    else if (aMinor < bMinor) return 1;
	    else if (aMinor > bMinor) return -1;
	    else return 0;
	});
	return result;
    },

    getLatestPath: function() {
	let all = this._getAll();
	if (all.length == 0)
	    return null;
	return this._path.get_child(all[0][3]);
    },

    getPreviousPath: function(path) {
        let name = path.get_basename();
	let [target_major, target_minor] = this.parseVersion(name);
	let files = this._getAll();
        let prev = null;
        let found = false;
	for (let i = files.length - 1; i >= 0; i--) {
	    let [major, minor, csum, fname] = files[i];
            if (target_major == major && target_minor == minor) {
                found = true;
                break;
	    }
            prev = fname;
	}
        if (found && prev)
            return this._path.get_child(prev);
        return null;
    },

    loadFromPath: function(path, cancellable) {
	return JsonUtil.loadJson(this._path.get_child(path.get_basename()), cancellable);
    }
});
