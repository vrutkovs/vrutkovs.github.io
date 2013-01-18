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

const loop = GLib.MainLoop.new(null, true);

const TIMEOUT_SECONDS = 2 * 60;

const QaSmokeTest = new Lang.Class({
    Name: 'QaSmokeTest',

    RequiredMessageIDs: ["39f53479d3a045ac8e11786248231fbf", // graphical.target 
                         "f77379a8490b408bbe5f6940505a777b"], // systemd-journald
    FailedMessageIDs: ["fc2e22bc6ee647b6b90729ab34a250b1"], // coredump

    _onQemuExited: function(proc, result) {
        let [success, status] = ProcUtil.asyncWaitCheckFinish(proc, result);
        this._qemu = null;
        loop.quit();
        if (!success) {
            this._failed = true;
            print("Qemu exited with status " + status);
        }
    },

    _onTimeout: function() {
        print("Timeout reached");
        this._failed = true;
        loop.quit();
    },

    _onJournalOpen: function(file, result) {
        try {
            this._journalStream = file.read_finish(result);
            this._journalDataStream = Gio.DataInputStream.new(this._journalStream); 
            this._openedJournal = true;
            this._journalDataStream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable,
                                                    Lang.bind(this, this._onJournalReadLine));
        } catch (e) {
            print("Open failed: " + e);
            this._failed = true;
            loop.quit();
        }
    },
    
    _onJournalReadLine: function(stream, result) {
        let line, len;
        try {
            [line, len] = stream.read_line_finish_utf8(result);
        } catch (e) {
            this._failed = true;
            loop.quit();
            throw e;
        }
        if (line) {
            let data = JSON.parse(line);
            let messageId = data['MESSAGE_ID'];
            if (messageId) {
                if (this._pendingRequiredMessageIds[messageId]) {
                    print("Found required message ID " + messageId);
                    delete this._pendingRequiredMessageIds[messageId];
                    this._countPendingRequiredMessageIds--;
                } else {
                    for (let i = 0; i < this.FailedMessageIDs.length; i++) {
                        if (messageId == this.FailedMessageIDs[i]) {
                            print("Found failure message ID " + messageId);
                            this._failed = true;
                            loop.quit();
                        }
                    }
            }
            if (this._countPendingRequiredMessageIds > 0) {
                this._readingJournal = true;
                this._journalDataStream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable,
                                                        Lang.bind(this, this._onJournalReadLine));
            } else {
                print("Found all required message IDs, exiting");
                loop.quit();
            }
        }
    },

    _onJournalChanged: function(monitor, file, otherFile, eventType) {
        if (!this._openedJournal) {
            this._openedJournal = true;
            file.read_async(GLib.PRIORITY_DEFAULT,
                            this._cancellable,
                            Lang.bind(this, this._onJournalOpen));
        } else if (!this._readingJournal) {
            this._readingJournal = true;
            this._journalDataStream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable,
                                                    Lang.bind(this, this._onJournalReadLine));
        }
    },

    execute: function(argv) {
        let cancellable = null;
        let parser = new ArgParse.ArgumentParser("Basic smoke testing via parsing serial console");
        parser.addArgument('--monitor', { action: 'storeTrue' });
        parser.addArgument('diskpath');
        
        let args = parser.parse(argv);

        this._failed = false;
        this._journalStream = null;
        this._journalDataStream = null;
        this._openedJournal = false;
        this._readingJournal = false;
        this._pendingRequiredMessageIds = {};
        this._countPendingRequiredMessageIds = 0;
        for (let i = 0; i < this.RequiredMessageIDs.length; i++) {
            this._pendingRequiredMessageIds[this.RequiredMessageIDs[i]] = true;
            this._countPendingRequiredMessageIds += 1;
        }
        this._cancellable = cancellable;

        let srcDiskpath = Gio.File.new_for_path(args.diskpath);
        let workdir = Gio.File.new_for_path('.');
        
        let qemuArgs = [LibQA.getQemuPath()];
        qemuArgs.push.apply(qemuArgs, LibQA.DEFAULT_QEMU_OPTS);

        let diskClone = workdir.get_child('qa-smoketest.img');
        GSystem.shutil_rm_rf(diskClone, cancellable);

        LibQA.createDiskSnapshot(srcDiskpath, diskClone, cancellable);
        let [gfmnt, mntdir] = LibQA.newReadWriteMount(diskClone, cancellable);
        try {
            LibQA.modifyBootloaderAppendKernelArgs(mntdir, ["console=ttyS0"], cancellable);

            let [currentDir, currentEtcDir] = LibQA.getDeployDirs(mntdir, 'gnome-ostree');
            let binDir = currentDir.resolve_relative_path('usr/bin');
            // let systemdSystemDir = currentDir.resolve_relative_path('usr/lib/systemd/system');
            let multiuserWantsDir = currentEtcDir.resolve_relative_path('systemd/system/multi-user.target.wants');
            
            let datadir = Gio.File.new_for_path(GLib.getenv('OSTBUILD_DATADIR'));
            let exportScript = datadir.resolve_relative_path('tests/gnome-ostree-export-journal-to-serialdev');
            let exportScriptService = datadir.resolve_relative_path('tests/gnome-ostree-export-journal-to-serialdev.service');
            let exportBin = binDir.get_child(exportScript.get_basename());
            exportScript.copy(exportBin, 0, cancellable, null, null);
            GSystem.file_chmod(exportBin, 493, cancellable);
            exportScriptService.copy(multiuserWantsDir.get_child(exportScriptService.get_basename()), 0, cancellable, null, null);
        } finally {
            gfmnt.umount(cancellable);
        }

        let consoleOutput = Gio.File.new_for_path('console.out');
        GSystem.shutil_rm_rf(consoleOutput, cancellable);
        let journalOutput = Gio.File.new_for_path('journal-json.txt');
        GSystem.shutil_rm_rf(journalOutput, cancellable);

        qemuArgs.push.apply(qemuArgs, ['-drive', 'file=' + diskClone.get_path() + ',if=virtio',
                                       '-vnc', 'none',
                                       '-watchdog', 'ib700',
                                       '-watchdog-action', 'poweroff',
                                       '-serial', 'file:' + consoleOutput.get_path(),
                                       '-device', 'virtio-serial',
                                       '-chardev', 'file,id=journaljson,path=' + journalOutput.get_path(),
                                       '-device', 'virtserialport,chardev=journaljson,name=org.gnome.journaljson']);
        if (args.monitor)
            qemuArgs.push.apply(qemuArgs, ['-monitor', 'stdio']);
        
        let qemuContext = new GSystem.SubprocessContext({ argv: qemuArgs });
        if (args.monitor)
            qemuContext.set_stdin_disposition(GSystem.SubprocessStreamDisposition.INHERIT);
        let qemu = new GSystem.Subprocess({context: qemuContext});
        this._qemu = qemu;
        print("starting qemu");
        qemu.init(cancellable);

        qemu.wait(cancellable, Lang.bind(this, this._onQemuExited));

        let journalMonitor = journalOutput.monitor_file(0, cancellable);
        journalMonitor.connect('changed', Lang.bind(this, this._onJournalChanged));

        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT_SECONDS,
                                 Lang.bind(this, this._onTimeout));
        
        loop.run();

        if (this._qemu)
            this._qemu.force_exit();
        
        if (this._failed) {
            print("Exiting abnormally");
            return 1;
        }
        print("Complete!");
        return 0;
    }
});

function main(argv) {
    let ecode = 1;
    var app = new QaSmokeTest();
    GLib.idle_add(GLib.PRIORITY_DEFAULT,
                  function() { try { ecode = app.execute(argv); } finally { loop.quit(); }; return false; });
    loop.run();
    return ecode;
}
