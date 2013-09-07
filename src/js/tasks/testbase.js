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
const LibQA = imports.libqa;
const JSUtil = imports.jsutil;
const JSONUtil = imports.jsonutil;

const TIMEOUT_SECONDS = 10 * 60;
const COMPLETE_IDLE_WAIT_SECONDS = 10;

const TestOneDisk = new Lang.Class({
    Name: 'TestOneDisk',

    _init: function(parentTask, testRequiredMessageIds, testFailedMessageIds, testStatusMessageId) {
        this._parentTask = parentTask;
        this._testRequiredMessageIds = testRequiredMessageIds;
        this._testFailedMessageIds = testFailedMessageIds;
        this._statusMessageId = testStatusMessageId;
    },

    _fail: function(message) {
        if (this._failed)
            return;
        this._failed = true;
        this._failedMessage = message;
        this._screenshot(true);
    },
    
    _onQemuExited: function(proc, result) {
        let [success, status] = ProcUtil.asyncWaitCheckFinish(proc, result);
        this._qemu = null;
        this._loop.quit();
        if (!success) {
            this._fail("Qemu exited with status " + status);
        }
    },

    _onTimeout: function() {
        print("Timeout reached");
        for (let msgid in this._pendingRequiredMessageIds) {
            print("Did not see MESSAGE_ID=" + msgid);
        }
        this._fail("Timed out");
        this._loop.quit();
    },

    _onJournalOpen: function(file, result) {
        try {
            this._journalStream = file.read_finish(result);
            this._journalDataStream = Gio.DataInputStream.new(this._journalStream); 
            this._openedJournal = true;
            this._readingJournal = true;
            this._journalDataStream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable,
                                                    Lang.bind(this, this._onJournalReadLine));
        } catch (e) {
            this._fail("Journal open failed: " + e);
            this._loop.quit();
        }
    },
    
    _onJournalReadLine: function(stream, result) {
        this._readingJournal = false;
        let line, len;
        try {
            [line, len] = stream.read_line_finish_utf8(result);
        } catch (e) {
            this._fail(e.toString());
            this._loop.quit();
            throw e;
        }
        if (this._foundAllMessageIds || this._failed)
            return;
        if (line) {
            let data = JSON.parse(line);
            let message = data['MESSAGE'];
            let messageId = data['MESSAGE_ID'];
            if (messageId) {
                if (this._pendingRequiredMessageIds[messageId]) {
                    print("Found required message ID " + messageId);
                    print(message);
                    delete this._pendingRequiredMessageIds[messageId];
                    this._countPendingRequiredMessageIds--;
                } else if (this._failMessageIds[messageId]) {
                    this._fail("Found failure message ID " + messageId);
                    print(message);
                    this._loop.quit();
                }
                if (messageId === this._statusMessageId) {
                    print(message);
	                  let statusTxtPath = Gio.File.new_for_path('status.txt');
	                  statusTxtPath.replace_contents(message + '\n', null, false,
				                                           Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable);
                }
                this._parentTask._handleMessage(data, this._cancellable);
            }
            if (this._countPendingRequiredMessageIds == 0 && !this._foundAllMessageIds) {
                print("Found all required message IDs");
                this._foundAllMessageIds = true;
                GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, COMPLETE_IDLE_WAIT_SECONDS,
                                         Lang.bind(this, this._onFinalWait));
            } else {
                this._readingJournal = true;
                this._journalDataStream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable,
                                                        Lang.bind(this, this._onJournalReadLine));
            }
        }
    },

    _onJournalChanged: function(monitor, file, otherFile, eventType) {
        if (this._foundAllMessageIds || this._failed)
            return;
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
    
    _ensureQemuConnection: function() {
        if (!this._qemuSocketConn) {
            let path = Gio.File.new_for_path('.').get_relative_path(this._subworkdir.get_child("qemu.monitor"));
            let address = Gio.UnixSocketAddress.new_with_type(path, Gio.UnixSocketAddressType.PATH);
            let socketClient = new Gio.SocketClient();
            this._qemuSocketConn = socketClient.connect(address, this._cancellable);
            this._qemuOut = Gio.DataOutputStream.new(this._qemuSocketConn.get_output_stream());
            this._qemuIn = Gio.DataInputStream.new(this._qemuSocketConn.get_input_stream());
            let [response, len] = this._qemuIn.read_line_utf8(this._cancellable);
            this._qemuCommand({ "execute": "qmp_capabilities" });
        }
    },

    _qemuCommand: function(cmd) {
        this._ensureQemuConnection();
        let cmdStr = JSON.stringify(cmd);
        this._qemuOut.put_string(cmdStr, this._cancellable);
        let [response, len] = this._qemuIn.read_line_utf8(this._cancellable);
    },

    _screenshot: function(isFinal) {
        let filename;
        let modified = true;
        if (isFinal)
            filename = "screenshot-final.ppm";
        else
            filename = "screenshot-" + this._screenshotSerial + ".ppm";

        this._qemuCommand({"execute": "screendump", "arguments": { "filename": filename }});

        let filePath = this._subworkdir.get_child(filename);

        if (!isFinal) {
	          let contentsBytes = GSystem.file_map_readonly(filePath, this._cancellable);
	          let csum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256,
						                                           contentsBytes);
            
            modified = this._lastScreenshotChecksum != csum;
            if (!modified) {
                GSystem.file_unlink(filePath, this._cancellable);
            } else {
                this._lastScreenshotChecksum = csum;
            }
            this._screenshotSerial++;
        }

        // Convert to PNG if possible
        if (modified && imports.gi.GdkPixbuf) {
            let GdkPixbuf = imports.gi.GdkPixbuf;
            let pixbuf = null;
            try {
                pixbuf = GdkPixbuf.Pixbuf.new_from_file(filePath.get_path());
                
            } catch (e) {
                if (e.domain != GdkPixbuf.PixbufError)
                    throw e;
                print(e);
            }
            if (pixbuf != null) {
                let outFilename = this._subworkdir.get_child(filename.replace(/ppm$/, 'png'));
                pixbuf.savev(outFilename.get_path(), "png", [], []);
            }
            GSystem.file_unlink(filePath, this._cancellable);
        }
    },

    _idleScreenshot: function() {
        this._screenshot(false);
        return true;
    },

    _onFinalWait: function() {
        print("Final wait complete");

        this._screenshot(true);

        this._loop.quit();
    },

    execute: function(subworkdir, buildData, repo, diskPath, cancellable) {
        print("Testing disk " + diskPath.get_path());
        this._buildData = buildData;
        this._repo = repo;
        this._subworkdir = subworkdir;
        this._loop = GLib.MainLoop.new(null, true);
        this._foundAllMessageIds = false;
        this._failed = false;
        this._journalStream = null;
        this._journalDataStream = null;
        this._openedJournal = false;
        this._readingJournal = false;
        this._pendingRequiredMessageIds = {};
        this._failMessageIds = {};
        this._countPendingRequiredMessageIds = 0;
        this._screenshotSerial = 0;
        this._lastScreenshotChecksum = null;
        this._qemuSocket = null;
        print("Will wait for message IDs: " + JSON.stringify(this._testRequiredMessageIds));
        for (let i = 0; i < this._testRequiredMessageIds.length; i++) {
            this._pendingRequiredMessageIds[this._testRequiredMessageIds[i]] = true;
            this._countPendingRequiredMessageIds += 1;
        }
        for (let i = 0; i < this._testFailedMessageIds.length; i++) {
            this._failMessageIds[this._testFailedMessageIds[i]] = true;
        }
        this._cancellable = cancellable;

        // HACK
        if (diskPath.get_basename().indexOf('x86_64') >= 0)
            this._diskArch = 'x86_64';
        else
            this._diskArch = 'i686';

        let qemuArgs = LibQA.getDefaultQemuOptions({ parallel: true });
    
        let diskClone = subworkdir.get_child('testoverlay-' + diskPath.get_basename());
        GSystem.shutil_rm_rf(diskClone, cancellable);

        LibQA.createDiskSnapshot(diskPath, diskClone, cancellable);
        let [gfmnt, mntdir] = LibQA.newReadWriteMount(diskClone, cancellable);
        try {
            LibQA.modifyBootloaderAppendKernelArgs(mntdir, ["console=ttyS0"], cancellable);

            let [currentDir, currentEtcDir] = LibQA.getDeployDirs(mntdir, 'gnome-ostree');
            
            LibQA.injectExportJournal(currentDir, currentEtcDir, cancellable);
            LibQA.injectTestUserCreation(currentDir, currentEtcDir, 'testuser', {}, cancellable);
            LibQA.enableAutologin(currentDir, currentEtcDir, 'testuser', cancellable);

            this._parentTask._prepareDisk(mntdir, this._diskArch, cancellable);
        } finally {
            gfmnt.umount(cancellable);
        }

        let consoleOutput = subworkdir.get_child('console.out');
        let journalOutput = subworkdir.get_child('journal-json.txt');

        qemuArgs.push.apply(qemuArgs, ['-drive', 'file=' + diskClone.get_path() + ',if=virtio',
                                       '-vnc', 'none',
                                       '-serial', 'file:' + consoleOutput.get_path(),
                                       '-chardev', 'socket,id=charmonitor,path=qemu.monitor,server,nowait',
                                       '-mon', 'chardev=charmonitor,id=monitor,mode=control',
                                       '-device', 'virtio-serial',
                                       '-chardev', 'file,id=journaljson,path=' + journalOutput.get_path(),
                                       '-device', 'virtserialport,chardev=journaljson,name=org.gnome.journaljson']);
        
        let qemuContext = new GSystem.SubprocessContext({ argv: qemuArgs });
        qemuContext.set_cwd(subworkdir.get_path());
        let qemu = new GSystem.Subprocess({context: qemuContext});
        this._qemu = qemu;
        print("starting qemu : " + qemuArgs.join(' '));
        qemu.init(cancellable);

        qemu.wait(cancellable, Lang.bind(this, this._onQemuExited));

        let journalMonitor = journalOutput.monitor_file(0, cancellable);
        journalMonitor.connect('changed', Lang.bind(this, this._onJournalChanged));

        let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT_SECONDS,
                                                 Lang.bind(this, this._onTimeout));

        // Let's only do a screenshot every 3 seconds, I think it's slowing things down...
        let screenshotTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3,
                                                 Lang.bind(this, this._idleScreenshot));
        
        this._loop.run();

        if (this._qemu)
            this._qemu.force_exit();

        GLib.source_remove(timeoutId);
        
        if (this._failed) {
            throw new Error(this._failedMessage);
        }

        this._parentTask._postQemu(cancellable);

        print("Completed testing of " + diskPath.get_basename());
    }
});

const TestBase = new Lang.Class({
    Name: 'TestBase',
    Extends: Task.Task,

    TaskDef: {
        TaskName: "testbase",
        TaskAfter: ['builddisks'],
    },

    BaseRequiredMessageIDs: ["39f53479d3a045ac8e11786248231fbf", // graphical.target 
                             "f77379a8490b408bbe5f6940505a777b",  // systemd-journald
                            ],

    BaseFailedMessageIDs: [],

    RequiredMessageIDs: [],
    FailedMessageIDs: [],

    StatusMessageID: [],

    CompletedTag: null,

    _prepareDisk: function(mntdir, cancellable) {
        // Nothing, intended for subclasses
    },

    _handleMessage: function(message, cancellable) {
        return false;
    },

    _postQemu: function(cancellable) {
    },

    execute: function(cancellable) {
	      let imageDir = this.workdir.get_child('images');
	      let currentImages = imageDir.get_child('current');

        let e = currentImages.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                                                 cancellable);
        let info;
        let buildJson;
        let disksToTest = [];

        while ((info = e.next_file(cancellable)) != null) {
            let name = info.get_name();
            if (name.indexOf('build-') == 0 && JSUtil.stringEndswith(name, '.json')) {
                buildJson = e.get_child(info);
                continue;
            }
            if (!JSUtil.stringEndswith(name, '.qcow2'))
                continue;
            disksToTest.push(name);
        }
        e.close(null);
        this._buildData = null;
        if (buildJson != null)
            this._buildData = JSONUtil.loadJson(buildJson, cancellable);
        for (let i = 0; i < disksToTest.length; i++) {
            let name = disksToTest[i];
            let workdirName = 'work-' + name.replace(/\.qcow2$/, '');
            let subworkdir = Gio.File.new_for_path(workdirName);
            GSystem.file_ensure_directory(subworkdir, true, cancellable);
            let test = new TestOneDisk(this,
                                       this.BaseRequiredMessageIDs.concat(this.RequiredMessageIDs),
                                       this.BaseFailedMessageIDs.concat(this.FailedMessageIDs),
                                       this.StatusMessageID);
            test.execute(subworkdir, this._buildData, this.repo, currentImages.get_child(name), cancellable);
        }

        let buildData = this._buildData;
        if (buildJson != null && this.CompletedTag !== null) {
            let snapshot = buildData['snapshot'];
            this.ostreeRepo.prepare_transaction(cancellable);
            for (let targetName in buildData['targets']) {
                let targetRev = buildData['targets'][targetName];
                let lastSlash = targetName.lastIndexOf('/');
                let testedRefName = snapshot['osname'] + '/' + this.CompletedTag + targetName.substr(lastSlash);
                this.ostreeRepo.transaction_set_ref(null, testedRefName, targetRev);
                print(Format.vprintf("Wrote ref: %s => %s", [testedRefName, targetRev]));
            }
            this.ostreeRepo.commit_transaction(cancellable);
        } else {
            print("No build json found, not tagging");
        }
    }
});
