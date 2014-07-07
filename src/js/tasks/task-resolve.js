// Copyright (C) 2011 Colin Walters <walters@verbum.org>
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

const Task = imports.task;
const ProcUtil = imports.procutil;
const JsonUtil = imports.jsonutil;
const Snapshot = imports.snapshot;
const Vcs = imports.vcs;

const TaskResolve = new Lang.Class({
    Name: "TaskResolve",
    Extends: Task.Task,

    TaskDef: {
        TaskName: "resolve",
    },

    DefaultParameters: {fetchAll: false,
                        fetchSrcUrls: [],
			fetchComponents: [],
		        timeoutSec: 10},

    _writeSnapshotToBuild: function(cancellable) {
        let data = this._snapshot.data;
        let buf = JsonUtil.serializeJson(data);

        let oldSnapshot = this.builddir.get_child('last-build/snapshot.json');
        if (oldSnapshot.query_exists(cancellable)) {
            let oldBytes = GSystem.file_map_readonly(oldSnapshot, cancellable);
            let oldCsum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, oldBytes);
            let newCsum = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, buf, -1);
            if (oldCsum == newCsum)
                return false;
        }

        let snapshot = this.builddir.get_child('snapshot.json');
        JsonUtil.writeJsonFileAtomic(snapshot, data, cancellable);
        return true;
    },

    _baseCommitFromDescribe: function(describe) {
	if (describe.length == 40)
	    return describe;
	let g = describe.lastIndexOf('g');
	if (g == -1)
	    throw new Error("Failed to determine commit from " + describe);
	let commit = describe.substring(g+1);
	if (commit.length != 40) 
	    throw new Error("Failed to determine commit from " + describe);
	return commit;
    },

    _storeComponentRevision: function(component, resolveCache, cancellable) {
        let tagOrBranch = component['tag'] || component['branch'] || 'master';
        let mirrordir;
        let modifiedCache = false;

        try {
            mirrordir = Vcs.ensureVcsMirror(this.mirrordir, component, cancellable);
        } catch (e) {
            print("Failed to create mirror for component " + component['name']);
            throw e;
        }
        let currentCommit = Vcs.revParse(mirrordir, tagOrBranch, cancellable);
        let revision = null;
        let cachedEntry = resolveCache[component['name']];
        if (cachedEntry) {
            let previousCommit = cachedEntry['revision'];
            if (currentCommit == previousCommit)
                revision = cachedEntry['describe'];
        }
        if (revision == null) {
            print("Describe cache miss for " + component['name']);
            revision = Vcs.describeVersion(mirrordir, tagOrBranch);
            modifiedCache = true;
            resolveCache[component['name']] = {'revision': currentCommit,
                                               'describe': revision};
        }
        component['revision'] = revision;

        if (component['child-components']) {
            let childComponents = component['child-components'];
            for (let i = 0; i < childComponents.length; i++) {
                modifiedCache = this._storeComponentRevision(childComponents[i], resolveCache, cancellable);
            }
        }

        return modifiedCache;
    },

    execute: function(cancellable) {
        let manifestPath = this.workdir.get_child('manifest.json');
        this._snapshot = Snapshot.fromFile(manifestPath, cancellable, { prepareResolve: true });

        let componentsToFetch = this.parameters.fetchComponents.slice();
        let srcUrls = this.parameters.fetchSrcUrls;
        for (let i = 0; i < srcUrls; i++) {
            let matches = snapshot.getMatchingSrc(srcUrls[i]);
            componentsToFetch.push.apply(matches);
        }

        let gitMirrorArgs = ['ostbuild', 'git-mirror', '--timeout-sec=' + this.parameters.timeoutSec,
			     '--workdir=' + this.workdir.get_path(),
			     '--manifest=' + manifestPath.get_path()];
        if (this.parameters.fetchAll || componentsToFetch.length > 0) {
            gitMirrorArgs.push('--fetch');
            gitMirrorArgs.push('-k');
	    gitMirrorArgs.push.apply(gitMirrorArgs, componentsToFetch);
	}
	ProcUtil.runSync(gitMirrorArgs, cancellable, { logInitiation: true });

	let resolveCachePath = this.cachedir.get_child('component-git-describe.json');
	let resolveCache = {};
	let modifiedCache = true;
	if (resolveCachePath.query_exists(null)) {
	    resolveCache = JsonUtil.loadJson(resolveCachePath, cancellable);
	    modifiedCache = false;
	}
	
	let componentNames = this._snapshot.getAllComponentNames();
	for (let i = 0; i < componentNames.length; i++) {
	    let component = this._snapshot.getComponent(componentNames[i]);
            modifiedCache = this._storeComponentRevision(component, resolveCache, cancellable);
	}

	if (modifiedCache)
            JsonUtil.writeJsonFileAtomic(resolveCachePath, resolveCache, cancellable);

        let modified = this._writeSnapshotToBuild(cancellable);
        if (modified) {
            print("New source snapshot");
        } else {
            print("Source snapshot unchanged");
	}

        let modifiedPath = Gio.File.new_for_path('modified.json');
        JsonUtil.writeJsonFileAtomic(modifiedPath, { modified: modified }, cancellable);
    }
});
