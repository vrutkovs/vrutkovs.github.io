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

const Builtin = imports.builtin;
const ArgParse = imports.argparse;
const ProcUtil = imports.procutil;
const GuestFish = imports.guestfish;

const QaMakeDisk = new Lang.Class({
    Name: 'QaMakeDisk',
    Extends: Builtin.Builtin,

    DESCRIPTION: "Generate a disk image",

    _init: function() {
        this.parent();
        this.parser.addArgument('diskpath');
    },

    execute: function(args, loop, cancellable) {
        let path = Gio.File.new_for_path(args.diskpath);
        if (path.query_exists(null))
            throw new Error("" + path.get_path() + " exists");

        let tmppath = path.get_parent().get_child(path.get_basename() + '.tmp');
        GSystem.shutil_rm_rf(tmppath, cancellable);
        let sizeMb = 8 * 1024;
        let bootsizeMb = 200;
        let swapsizeMb = 64;

        let guestfishProcess;
        
        ProcUtil.runSync(['qemu-img', 'create', '-f', 'qcow2', tmppath.get_path(), '' + sizeMb + 'M'], cancellable);
        let makeDiskCmd = 'launch\n\
part-init /dev/vda mbr\n\
blockdev-getsize64 /dev/vda\n\
blockdev-getss /dev/vda\n';
        let gf = new GuestFish.GuestFish(tmppath, {partitionOpts: [], readWrite: true});
        let lines = gf.run(makeDiskCmd, cancellable);
        if (lines.length != 2)
            throw new Error("guestfish returned unexpected output lines (" + lines.length + ", expected 2");
        let diskBytesize = parseInt(lines[0]);
        let diskSectorsize = parseInt(lines[1]);
        print(Format.vprintf("bytesize: %s sectorsize: %s", [diskBytesize, diskSectorsize]));
        let bootsizeSectors = bootsizeMb * 1024 / diskSectorsize * 1024;
        let swapsizeSectors = swapsizeMb * 1024 / diskSectorsize * 1024;
        let rootsizeSectors = diskBytesize / diskSectorsize - bootsizeSectors - swapsizeSectors - 64;
        let bootOffset = 64;
        let swapOffset = bootOffset + bootsizeSectors;
        let rootOffset = swapOffset + swapsizeSectors;
        let endOffset = rootOffset + rootsizeSectors;

        let partconfig = Format.vprintf('launch\n\
part-add /dev/vda p %s %s\n\
part-add /dev/vda p %s %s\n\
part-add /dev/vda p %s %s\n\
mkfs ext4 /dev/vda1\n\
set-e2label /dev/vda1 gnostree-boot\n\
mkswap-L gnostree-swap /dev/vda2\n\
mkfs ext4 /dev/vda3\n\
set-e2label /dev/vda3 gnostree-root\n\
mount /dev/vda3 /\n\
mkdir /boot\n\
', [bootOffset, swapOffset - 1,
    swapOffset, rootOffset - 1,
    rootOffset, endOffset - 1]);
        print("partition config: ", partconfig);
        lines = gf.run(partconfig, cancellable);
        GSystem.file_rename(tmppath, path, cancellable);
        print("Created: " + path.get_path());
    }
});
