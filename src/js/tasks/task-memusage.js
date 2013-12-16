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
const OSTree = imports.gi.OSTree;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Format = imports.format;

const GSystem = imports.gi.GSystem;

const Builtin = imports.builtin;
const ArgParse = imports.argparse;
const ProcUtil = imports.procutil;
const Task = imports.task;
const TestBase = imports.tasks.testbase;
const LibQA = imports.libqa;
const JSUtil = imports.jsutil;
const JSONUtil = imports.jsonutil;
const FileUtil = imports.fileutil;

const TaskMemusage = new Lang.Class({
    Name: 'TaskMemusage',
    Extends: TestBase.TestBase,

    TaskDef: {
        TaskName: "memusage",
        TaskAfter: ['smoketest'],
    },

    TestTrees: ['-devel-debug'],
    CompleteIdleWaitSeconds: 5,

    RequiredMessageIDs: ["0ce153587afa4095832d233c17a88001", // gnome-session ok
                         "c15ddcb848ed44d9b39fadcfe7a34795" // gnome-shell-valgrind ok
                        ],

    FailedMessageIDs:   [],

    _postQemu: function(mntdir, cancellable) {
        let osname = this._buildData['snapshot']['osname'];
        let varTmpDir = mntdir.resolve_relative_path('ostree/deploy/' + osname + '/var/tmp');
        let copied = [];
        print("Examining " + varTmpDir.get_path());
        FileUtil.walkDir(varTmpDir, { nameRegex: /massif-gnome-shell.*/,
                                      depth: 1 },
                         function (path, cancellable) {
                             let dest = Gio.File.new_for_path(path.get_basename());
                             print("Copying " + dest.get_path());
                             path.copy(dest, Gio.FileCopyFlags.OVERWRITE, cancellable, null, null);
                             copied.push(dest);
                         }, cancellable);
        print("Copied " + copied.length + " massif data files");
        for (let i = 0; i < copied.length; i++) {
            let path = copied[i].get_path();
            let context = new GSystem.SubprocessContext({ argv: ['ms_print', path ] });
            context.set_stdout_file_path(path + '.txt');
            let proc = new GSystem.Subprocess({ context: context });
            proc.init(cancellable);
            proc.wait_sync_check(cancellable);
        }
    },
   
    _prepareDisk: function(mntdir, arch, cancellable) {
        let osname = this._buildData['snapshot']['osname'];
        let datadir = LibQA.getDatadir();
        let [deployDir, deployEtcDir] = LibQA.getDeployDirs(mntdir, osname);
        let shellPath = deployDir.resolve_relative_path('usr/bin/gnome-shell');
        let shellDotRealPath = deployDir.resolve_relative_path('usr/bin/gnome-shell.real');
        GSystem.file_rename(shellPath, shellDotRealPath, cancellable);
        let massifWrapperSrc = datadir.resolve_relative_path('tests/gnome-shell-valgrind');
        massifWrapperSrc.copy(shellPath, Gio.FileCopyFlags.OVERWRITE, cancellable, null, null);
        GSystem.file_chmod(shellPath, 493, cancellable);
        print("Replaced " + shellPath.get_path() + " with massif wrapper");
    }
});
