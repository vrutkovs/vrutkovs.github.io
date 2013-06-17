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

const GSystem = imports.gi.GSystem;
const BuildUtil = imports.buildutil;

const VersionedDir = new Lang.Class({
    Name: 'VersionedDir',

    _init: function(path, regexp) {
	this.path = path;
	this._regexp = regexp;
	GSystem.file_ensure_directory(this.path, true, null);
    },

    loadVersions: function(cancellable) {
	let e = this.path.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
	let info;
	let results = [];
	while ((info = e.next_file(cancellable)) != null) {
	    let name = info.get_name();
	    let match = this._regexp.exec(name);
	    if (!match)
		continue;
	    results.push(name);
	}
	e.close(null);
	results.sort(BuildUtil.compareVersions);
	return results;
    },

    cleanOldVersions: function(retain, cancellable) {
	let versions = this.loadVersions(cancellable);
	while (versions.length > retain) {
	    let child = this.path.get_child(versions.shift());
	    GSystem.shutil_rm_rf(child, cancellable);
	}
    },
});
