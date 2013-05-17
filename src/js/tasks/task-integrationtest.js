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
const Task = imports.task;
const TestBase = imports.tasks.testbase;
const LibQA = imports.libqa;
const JSUtil = imports.jsutil;
const JSONUtil = imports.jsonutil;

const TaskIntegrationTest = new Lang.Class({
    Name: 'TaskIntegrationTest',
    Extends: TestBase.TestBase,

    TaskName: "integrationtest",
    TaskAfter: ['smoketest'],

    RequiredMessageIDs: ["4d013788dd704743b826436c951e551d" // Tests succeeded
                        ],

    FailedMessageIDs:   ["10dd2dc188b54a5e98970f56499d1f73", // gnome-session required component failed
                         "0eee66bf98514369bef9868327a43cf1" // Tests failed
                        ],

    StatusMessageID: "4d013788dd704743b826436c951e551d",

    CompletedTag: 'integrated',

    _prepareDisk: function(mntdir, arch, cancellable) {
        let osname = this._buildData['snapshot']['osname'];
        let [deployDir, deployEtcDir] = LibQA.getDeployDirs(mntdir, osname);
        let installedTestsName = osname + '/buildmaster/' +arch + '-installed-tests';
        let installedTestsRev = this._buildData['installed-tests'][installedTestsName];
        if (!installedTestsRev)
            throw new Error("No installed tests rev for " + installedTestsName);
        ProcUtil.runSync(['ostree', '--repo=' + this.repo.get_path(),
                          'checkout', '--no-triggers', '--user-mode', '--union', installedTestsRev, deployDir.get_path()], cancellable,
                         { logInitiation: true });
        let desktopFile = '[Desktop Entry]\n\
Encoding=UTF-8\n\
Name=GNOME installed tests runner\n\
Exec=gnome-desktop-testing-runner\n\
Terminal=false\n\
Type=Application\n';
        let dest = deployEtcDir.resolve_relative_path('xdg/autostart/gnome-desktop-testing.desktop');
        GSystem.file_ensure_directory(dest.get_parent(), true, cancellable);
        dest.replace_contents(desktopFile, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION,
                              cancellable);
    }
});
