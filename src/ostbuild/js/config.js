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

const GSystem = imports.gi.GSystem;

const Config = new Lang.Class({
    Name: 'Config',

    _init: function() {
	this._keyfile = new GLib.KeyFile();
	var path = GLib.build_filenamev([GLib.get_user_config_dir(), "ostbuild.cfg"]);
	this._keyfile.load_from_file(path, GLib.KeyFileFlags.NONE);
    },

    getGlobal: function(key, defaultValue)  {
	try {
	    return this._keyfile.get_string("global", key);
	} catch (e) {
	    if (e.domain == GLib.KeyFileError
		&& defaultValue != undefined)
		return defaultValue;
	    throw e;
	}
    },

    getPrefix: function() {
	let pathname = GLib.build_filenamev([GLib.get_user_config_dir(), "ostbuild-prefix"]);
	let path = Gio.File.new_for_path(pathname);
	if (!path.query_exists(null))
	    throw new Error("No prefix set; use \"ostbuild prefix\" to set one");
	let prefix = GSystem.file_load_contents_utf8(path, null);
	return prefix.replace(/[ \r\n]/g, '');
    }
});

var _instance = null;

function get() {
    if (_instance == null)
	_instance = new Config();
    return _instance;
}
