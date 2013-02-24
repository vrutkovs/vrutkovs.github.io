// Copyright (C) 2012,2013 Colin Walters <walters@verbum.org>
//
// This library is free software; you can redistribute it and/or
// modify it under the terms of the GNU Lesser General Public
// License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.
//
// This library is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Lesser General Public License for more details.
//
// You should have received a copy of the GNU Lesser General Public
// License along with this library; if not, write to the
// Free Software Foundation, Inc., 59 Temple Place - Suite 330,
// Boston, MA 02111-1307, USA.

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Format = imports.format;

const JsonUtil = imports.jsonutil;
const GSystem = imports.gi.GSystem;

const JsonDB = new Lang.Class({
    Name: 'JsonDB',

    _init: function(path) {
	this._path = path;
	GSystem.file_ensure_directory(this._path, true, null);
	this._re = /^(\d+)\.(\d+)-([0-9a-f]+).json$/;
	this._maxVersions = 5;
    },

    _parseVersion: function(basename) {
	let match = this._re.exec(basename);
	if (!match)
	    throw new Error("No JSONDB version in " + basename);
	return [parseInt(match[1]), parseInt(match[2])];
    },

    parseVersionStr: function(basename) {
	let [major, minor] = this._parseVersion(basename);
	return Format.vprintf('%d.%d', [major, minor]);
    },

    _getAll: function() {
	var result = [];
	var e = this._path.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
	let info;
	while ((info = e.next_file(null)) != null) {
	    let name = info.get_name();
	    let match = this._re.exec(name);
	    if (!match)
		continue;
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

    getLatestVersion: function() {
	let path = this.getLatestPath();
	if (path == null)
	    return null;
	return this.parseVersionStr(path.get_basename());
    },

    getPreviousPath: function(path) {
        let name = path.get_basename();
	let [target_major, target_minor] = this._parseVersion(name);
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
    },

    _updateIndex: function(cancellable) {
        let files = this._getAll();
	let fnames = [];
	for (let i = 0; i < files.length; i++) {
	    fnames.push(files[i][3]);
	}
	let index = { files: fnames };
	JsonUtil.writeJsonFileAtomic(this._path.get_child('index.json'), index, cancellable);
    },

    store: function(obj, cancellable) {
        let files = this._getAll();
	let latest = null;
        if (files.length > 0) {
            latest = files[0];
	}
	
	let currentTime = GLib.DateTime.new_now_utc();

	let buf = JSON.stringify(obj, null, "  ");
	let csum = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, buf, -1);
        
	let latestVersion;
        if (latest) {
            if (csum == latest[2]) {
                return [this._path.get_child(latest[3]), false];
	    }
            latestVersion = [latest[0], latest[1]];
        } else {
            latestVersion = [currentTime.get_year(), 0];
	}

        let targetName = Format.vprintf('%d.%d-%s.json', [currentTime.get_year(), latestVersion[1] + 1, csum]);
        let targetPath = this._path.get_child(targetName);
	targetPath.replace_contents(buf, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);

        if (files.length + 1 > this._maxVersions) {
	    for (let i = Math.max(files.length-(this._maxVersions-1), 0);
		 i < files.length;
		 i++) {
		GSystem.file_unlink(this._path.get_child(files[i][3]), cancellable);
	    }
	}

	this._updateIndex(cancellable);

        return [targetPath, true];
    }
});
