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

// From ot-gio-utils.h.
// XXX: Introspect this.
const OSTREE_GIO_FAST_QUERYINFO = ("standard::name,standard::type,standard::size,standard::is-symlink,standard::symlink-target," +
                                   "unix::device,unix::inode,unix::mode,unix::uid,unix::gid,unix::rdev");

const TaskIntegrationTest = new Lang.Class({
    Name: 'TaskIntegrationTest',
    Extends: TestBase.TestBase,

    TaskDef: {
        TaskName: "integrationtest",
        TaskAfter: ['smoketest'],
    },

    RequiredMessageIDs: ["4d013788dd704743b826436c951e551d" // Tests succeeded
                        ],

    FailedMessageIDs:   ["10dd2dc188b54a5e98970f56499d1f73", // gnome-session required component failed
                        ],

    StatusMessageID: "4d013788dd704743b826436c951e551d",

    CompletedTag: 'integrated',

    Timeout: 60 * 60,
    
    _handleMessage: function(message, cancellable) {
        let gdtrTest = message['GDTR_TEST'];
        if (!gdtrTest)
            return;
        let msgId = message['MESSAGE_ID'];
        if (!msgId)
            return;
        let msg = message['MESSAGE'];
        if (msgId == "0eee66bf98514369bef9868327a43cf1") {
            this._oneTestFailed = true;
            this._allTests[gdtrTest] = 'failed';
        } else if (msgId == 'ca0b037012363f1898466829ea163e7d') {
            this._allTests[gdtrTest] = 'skipped';
        } else if (msgId == '142bf5d40e9742e99d3ac8c1ace83b36') {
            this._allTests[gdtrTest] = 'success';
        } else {
            return;
        }
        print(msg);
    },

    _postQemu: function(mntdir, cancellable) {
        let testsJson = Gio.File.new_for_path('installed-test-results.json');
        JSONUtil.writeJsonFileAtomic(testsJson, this._allTests, null);

        let resultsDest = this.subworkdir.resolve_relative_path('installed-test-results');
        if (resultsDest.query_exists(null))
            GSystem.shutil_rm_rf(resultsDest, cancellable);
        resultsDest.make_directory(cancellable);
        let resultsSrc = mntdir.resolve_relative_path('home/testuser/installed-tests-results');
        FileUtil.walkDir(resultsSrc, { depth: 1, fileType: Gio.FileType.DIRECTORY },
            Lang.bind(this, function(filePath, cancellable) {
                try {
                    testResultsDest = resultsDest.resolve_relative_path(filePath.get_basename())
                    GSystem.shutil_cp_a(filePath, testResultsDest, cancellable);
                } catch (e) {
                    print(Format.vprintf('Cannot copy %s: %s', [filePath.get_basename(), e]));
                }
            }), cancellable);

        if (this._oneTestFailed) {
            throw new Error("Not all tests passed");
        }
    },

    _prepareDisk: function(mntdir, arch, cancellable) {
        let osname = this._buildData['snapshot']['osname'];
        let [deployDir, deployEtcDir] = LibQA.getDeployDirs(mntdir, osname);
        let installedTestsName = osname + '/buildmaster/' +arch + '-installed-tests';
        let installedTestsRev = this._buildData['installed-tests'][installedTestsName];
        if (!installedTestsRev)
            throw new Error("No installed tests rev for " + installedTestsName);

        let [, root] = this.ostreeRepo.read_commit(installedTestsRev, cancellable);
        let rootInfo = root.query_info(OSTREE_GIO_FAST_QUERYINFO,
                                       Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                                       cancellable);
        this.ostreeRepo.checkout_tree(OSTree.RepoCheckoutMode.USER,
                                      OSTree.RepoCheckoutOverwriteMode.UNION_FILES,
                                      deployDir, root, rootInfo, cancellable);

        let xfailTests = this._buildData['snapshot']['installed-tests-xfail'] || [];
        for (let i = 0; i < xfailTests.length; i++) {
            let xfail = xfailTests[i];
            let path = deployDir.resolve_relative_path('usr/share/installed-tests/' + xfail);
            if (path.query_exists(null))
                GSystem.file_unlink(path, cancellable);
            else
                print("NOTE: No such xfail test: " + xfail);
        }
        let desktopFile = '[Desktop Entry]\n\
Encoding=UTF-8\n\
Name=GNOME installed tests runner\n\
Exec=gnome-desktop-testing-runner --parallel 0 --status=yes --report-directory=/home/testuser/installed-tests-results\n\
Terminal=false\n\
Type=Application\n';
        let dest = deployEtcDir.resolve_relative_path('xdg/autostart/gnome-desktop-testing.desktop');
        GSystem.file_ensure_directory(dest.get_parent(), true, cancellable);
        dest.replace_contents(desktopFile, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION,
                              cancellable);

        this._allTests = {};
    }
});
