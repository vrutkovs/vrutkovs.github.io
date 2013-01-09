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
const Params = imports.params;
const ProcUtil = imports.procutil;

const GuestFish = new Lang.Class({
    Name: 'GuestFish',

    _init: function(diskpath, useLockFile) {
	this._diskpath = diskpath;
	if (useLockFile) {
	    let lockfilePath = diskpath.get_parent().get_child(diskpath.get_basename() + '.guestfish-lock');
	    this._lockfilePath = lockfilePath;
	} else {
	    this._lockfilePath = null;
	}
    },
    
    run: function(input, cancellable, params) {
	params = Params.parse(params, {partitionOpts: ['-i'],
				       readWrite: false});
	
	try {
	    let guestfishArgv = ['guestfish', '-a', this._diskpath.get_path()];
	    if (params.readWrite)
		guestfishArgv.push('--rw');
	    else
		guestfishArgv.push('--ro');
	    guestfishArgv.push.apply(guestfishArgv, params.partitionOpts);

	    let stream = this._lockfilePath.create(Gio.FileCreateFlags.NONE, cancellable);
	    stream.close(cancellable);
	    
	    return ProcUtil.runProcWithInputSyncGetLines(guestfishArgv, cancellable, input);
	} finally {
	    if (this._lockfilePath != null) {
		GSystem.file_unlink(this._lockfilePath, cancellable);
	    }
	}
    }
});

