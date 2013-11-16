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

// From ot-gio-utils.h.
// XXX: Introspect this.
const OSTREE_GIO_FAST_QUERYINFO = ("standard::name,standard::type,standard::size,standard::is-symlink,standard::symlink-target," +
                                   "unix::device,unix::inode,unix::mode,unix::uid,unix::gid,unix::rdev");

const TaskApplicationsTest = new Lang.Class({
    Name: 'TaskApplicationsTest',
    Extends: TestBase.TestBase,

    TaskDef: {
        TaskName: "applicationstest",
        TaskAfter: ['smoketest'],
    },

    RequiredMessageIDs: ["6912513dead443cea8ddb6b716185fa5" // Application test complete
                        ],

    FailedMessageIDs:   [],

    CompletedTag: 'applicationstest',

    _handleMessage: function(message, cancellable) {
        // coredump
        if (message['MESSAGE_ID'] == "fc2e22bc6ee647b6b90729ab34a250b1") {
            print(message['MESSAGE']);
            if (this._testingApp != null) {
                this._testingAppCoredumped = true;
            } 
        }
    },

    _extractIcon: function(appId, iconTuple, cancellable) {
        let [ext, iconBytes] = iconTuple;

        if (!iconBytes.length)
            return null;

        let iconDir = Gio.File.new_for_path('icons');
        GSystem.file_ensure_directory(iconDir, true, null);

        let icon = iconDir.get_child(appId + ext);
        let s = icon.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
        s.write_bytes(iconBytes.toGBytes(), cancellable);
        s.close(cancellable);
        return icon;
    },

    _screenshotTaken: function(path) {
        if (this._testingApp) {
            let app = this._allApps[this._testingApp];
            app.screenshot = this.workdir.get_relative_path(path);
        }
    },

    _onCommandChannelAsyncMessage: function(msgId, value) {
        if (msgId == 'TestingAppStart') {
            let [appId, iconTuple] = value.deep_unpack();
            print("got testingAppStart id=" + appId);
            this._testingApp = appId;
            let app = {};
            let icon = this._extractIcon(appId, iconTuple, null);
            if (icon)
                app.icon = this.workdir.get_relative_path(icon);
            app.state = 'running';
            this._allApps[this._testingApp] = app;
            this._testingAppCoredumped = false;
        } else if (msgId == 'TestingAppTimedOut') {
            print("got TestingAppTimedOut");
            let app = this._allApps[this._testingApp];
            app.state = 'timeout';
            this._testingApp = null;
        } else if (msgId == 'TestingAppComplete') {
            let app = this._allApps[this._testingApp];
            let successfulStr = !this._testingAppCoredumped ? 'success' : 'failed';
            print("got TestingAppComplete success=" + successfulStr);
            app.state = successfulStr;
            this._testingApp = null;
        } else {
            print("Got unknown asyncmessage: " + msgId);
        }
    },

    _onSuccess: function() {
        print("Successful; allApps=" + JSON.stringify(this._allApps));
        let appsDataPath = Gio.File.new_for_path('apps.json');
        JSONUtil.writeJsonFileAtomic(appsDataPath, {'apps': this._allApps }, null);
    },
   
    _prepareDisk: function(mntdir, arch, cancellable) {
        this._allApps = {};
        let osname = this._buildData['snapshot']['osname'];
        let datadir = LibQA.getDatadir();
        let startStopAppsName = 'gnome-continuous-startstopapps';
        let startStopAppsSrc = datadir.resolve_relative_path('tests/' + startStopAppsName);
        let [deployDir, deployEtcDir] = LibQA.getDeployDirs(mntdir, osname);
        let startStopAppsDest = deployDir.resolve_relative_path('usr/bin/' + startStopAppsName);
        print("Copying to " + startStopAppsDest.get_path());
        startStopAppsSrc.copy(startStopAppsDest, Gio.FileCopyFlags.OVERWRITE, cancellable, null, null);
        GSystem.file_chmod(startStopAppsDest, 493, cancellable);
        let desktopFile = '[Desktop Entry]\n\
Encoding=UTF-8\n\
Name=GNOME Applications\n\
Exec=/usr/bin/gnome-continuous-startstopapps\n\
Terminal=false\n\
Type=Application\n';
        let dest = deployEtcDir.resolve_relative_path('xdg/autostart/gnome-continuous-startstop-apps.desktop');
        GSystem.file_ensure_directory(dest.get_parent(), true, cancellable);
        dest.replace_contents(desktopFile, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION,
                              cancellable);
        let commandChannelUdevRule = 'ACTION=="add", SUBSYSTEM=="virtio-ports", MODE="0666"'
        let udevRuleDest = deployDir.resolve_relative_path('usr/lib/udev/rules.d/42-gnome-continuous-world-rw-virtio.rules');
        udevRuleDest.replace_contents(commandChannelUdevRule, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
    }
});
