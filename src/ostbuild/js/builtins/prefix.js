// Copyright (C) 2011,2012 Colin Walters <walters@verbum.org>
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

const Builtin = imports.builtin;
const Config = imports.config;
const ArgParse = imports.argparse;

const Prefix = new Lang.Class({
    Name: 'Prefix',
    Extends: Builtin.Builtin,

    DESCRIPTION: "Display or modify \"prefix\" (build target)",

    _init: function() {
	this.parent();
        this.parser.addArgument(['-a', '--active'], {action: 'storeTrue'});
        this.parser.addArgument('prefix');
    },

    execute: function(args, loop, cancellable) {
	let filepath = GLib.build_filenamev([GLib.get_user_config_dir(), "ostbuild-prefix"]);
        this.path = Gio.File.new_for_path(filepath);
        this._setPrefix(args.prefix, cancellable);
    },

    _setPrefix: function(prefix, cancellable) {
	this.path.replace_contents(prefix, null, false, 0, cancellable);
        print("Prefix is now " + prefix);
    },
});
