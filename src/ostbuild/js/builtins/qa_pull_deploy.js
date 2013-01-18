// -*- indent-tabs-mode: nil; tab-width: 2; -*-
// Copyright (C) 2013 Colin Walters <walters@verbum.org>
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

const ArgParse = imports.argparse;
const ProcUtil = imports.procutil;
const LibQA = imports.libqa;
const GuestFish = imports.guestfish;

const loop = GLib.MainLoop.new(null, true);

const QaPullDeploy = new Lang.Class({
    Name: 'QaPullDeploy',

    execute: function(argv) {
        let cancellable = null;
        let parser = new ArgParse.ArgumentParser("Generate a disk image");
        parser.addArgument('diskpath');
        parser.addArgument('srcrepo');
        parser.addArgument('osname');
        parser.addArgument('target');
        
        let args = parser.parse(argv);

        let diskpath = Gio.File.new_for_path(args.diskpath);

        this._workdir = Gio.File.new_for_path('.');
        this._mntdir = this._workdir.get_child('mnt');
        GSystem.file_ensure_directory(this._mntdir, true, cancellable);

        let gfmnt = new GuestFish.GuestMount(diskpath, { partitionOpts: LibQA.DEFAULT_GF_PARTITION_OPTS,
                                                         readWrite: true });
        gfmnt.mount(this._mntdir, cancellable);
        try {
            LibQA.pullDeploy(this._mntdir, Gio.File.new_for_path(args.srcrepo),
                             args.osname, args.target, cancellable);
        } finally {
            gfmnt.umount(cancellable);
        }

        LibQA.grubInstall(diskpath, cancellable);
        print("Complete!");
    }
});

function main(argv) {
    let ecode = 1;
    var app = new QaPullDeploy();
    GLib.idle_add(GLib.PRIORITY_DEFAULT,
                  function() { try { app.execute(argv); ecode = 0; } finally { loop.quit(); }; return false; });
    loop.run();
    return ecode;
}
