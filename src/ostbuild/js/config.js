const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

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
