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
const Task = imports.task;
const ProcUtil = imports.procutil;
const BuildUtil = imports.buildutil;
const LibQA = imports.libqa;
const JsonUtil = imports.jsonutil;
const JSUtil = imports.jsutil;
const GuestFish = imports.guestfish;

const IMAGE_RETAIN_COUNT = 2;

const TaskBuildDisks = new Lang.Class({
    Name: 'TaskBuildDisks',
    Extends: Task.Task,

    TaskDef: {
        TaskName: "builddisks",
        TaskAfter: ['build'],
    },

    // Legacy
    _VERSION_RE: /^(\d+)\.(\d+)$/,

    _inheritPreviousDisk: true,
    _onlyTreeSuffixes: ['-runtime'],

    execute: function(cancellable) {
        let buildData = JsonUtil.loadJson(this.builddir.get_child('build.json'), cancellable);

        let prevImageDir = this.builddir.get_child('last-build/images');
        let targetImageDir = this.builddir.get_child('images');
        let workImageDir = Gio.File.new_for_path('images');
        GSystem.file_ensure_directory(workImageDir, true, cancellable);

        let targets = buildData['targets'];
        let osname = buildData['snapshot']['osname'];
        let originRepoUrl = buildData['snapshot']['repo'];

        for (let targetName in targets) {
            let matched = false;
            for (let i = 0; i < this._onlyTreeSuffixes.length; i++) {
                if (JSUtil.stringEndswith(targetName, this._onlyTreeSuffixes[i])) {
                    matched = true;
                    break;
                }
            }
            if (!matched)
                continue;
            let targetRevision = buildData['targets'][targetName];
	          let squashedName = osname + '-' + targetName.substr(targetName.lastIndexOf('/') + 1);
	          let diskName = squashedName + '.qcow2';
            let diskPath = workImageDir.get_child(diskName);
            let prevPath = prevImageDir.get_child(diskName);
            GSystem.shutil_rm_rf(diskPath, cancellable);
            let doCloneDisk = this._inheritPreviousDisk && prevPath.query_exists(null);
            if (doCloneDisk) {
                LibQA.copyDisk(prevPath, diskPath, cancellable);
            } else {
                LibQA.createDisk(diskPath, cancellable);
            }
            let mntdir = Gio.File.new_for_path('mnt-' + squashedName);
            GSystem.file_ensure_directory(mntdir, true, cancellable);
            let gfmnt = new GuestFish.GuestMount(diskPath, { partitionOpts: LibQA.DEFAULT_GF_PARTITION_OPTS,
                                                             readWrite: true });
            gfmnt.mount(mntdir, cancellable);
            try {
                LibQA.pullDeploy(mntdir, this.repo, osname, targetName, targetRevision, originRepoUrl,
                                 cancellable);
            } finally {
                gfmnt.umount(cancellable);
            }
            // Assume previous disks have successfully installed a bootloader
            if (!doCloneDisk) {
                LibQA.bootloaderInstall(diskPath, Gio.File.new_for_path('.'), osname, cancellable);
                print("Bootloader installation complete");
            }

            this._postDiskCreation(squashedName, diskPath, cancellable);
            print("post-disk creation complete");
	      }

        GSystem.file_rename(workImageDir, targetImageDir, cancellable);
    },

    _postDiskCreation: function(squashedName, diskPath, cancellable) {
        // Nothing, this is used by zdisks
    }
});
