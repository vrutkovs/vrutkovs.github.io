// Copyright (C) 2011,2012,2013 Colin Walters <walters@verbum.org>
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
const Task = imports.task;
const ProcUtil = imports.procutil;
const StreamUtil = imports.streamutil;
const JsonUtil = imports.jsonutil;
const Snapshot = imports.snapshot;
const BuildUtil = imports.buildutil;
const Vcs = imports.vcs;
const ArgParse = imports.argparse;

const TaskBdiff = new Lang.Class({
    Name: "TaskBdiff",
    Extends: Task.Task,

    TaskDef: {
        TaskName: "bdiff",
        TaskAfter: ['build'],
    },

    _gitLogToJson: function(repoDir, specification) {
	let log = ProcUtil.runSyncGetOutputLines(['git', 'log', '--format=email', specification],
						 null,
						 { cwd: repoDir, logInitiation: true });
	let r = [];
	if (log.length == 0)
	    return r;
	let currentItem = null;
	let parsingHeaders = false;
	let fromRegex = /^From ([0-9a-f]{40}) /;
	for (let i = 0; i < log.length; i++) {
	    let line = log[i];
	    let match = fromRegex.exec(line);
	    if (match) {
		if (currentItem !== null) {
		    r.push(currentItem);
		}
		currentItem = {'Checksum': match[1]};
		parsingHeaders = true;
	    } else if (parsingHeaders) {
		if (line.length == 0) {
		    parsingHeaders = false;
		} else {
		    let idx = line.indexOf(':');
		    let k = line.substr(0, idx);
		    let v = line.substr(idx+1);
		    currentItem[k] = v;
		}
	    }
	}
	if (currentItem !== null) {
	    r.push(currentItem);
	}
	return r;
    },

    _diffstat: function(repoDir, specification) {
	return ProcUtil.runSyncGetOutputUTF8(['git', 'diff', '--stat', specification], null,
					     { cwd: repoDir });
    },

    execute: function(cancellable) {
	let builddb = this._getResultDb('build');
        let latestPath = builddb.getLatestPath();
	if (!latestPath)
	    throw new Error("No builds!")
        let latestBuildVersion = builddb.parseVersionStr(latestPath.get_basename());

        let previousPath = builddb.getPreviousPath(latestPath);
	if (!previousPath)
	    throw new Error("No build previous to " + latestBuildVersion)

        let latestBuildData = builddb.loadFromPath(latestPath, cancellable);
	let latestBuildSnapshot = new Snapshot.Snapshot(latestBuildData['snapshot'], null);
        let previousBuildData = builddb.loadFromPath(previousPath, cancellable);
	let previousBuildSnapshot = new Snapshot.Snapshot(previousBuildData['snapshot'], null);

	let added = [];
	let modified = [];
	let removed = [];

	let result = {fromBuildVersion: builddb.parseVersionStr(previousPath.get_basename()),
		      toBuildVersion: builddb.parseVersionStr(latestPath.get_basename()),
		      fromSrcVersion: builddb.parseVersionStr(previousBuildData['snapshotName']),
		      toSrcVersion: builddb.parseVersionStr(latestBuildData['snapshotName']),
		      added: added,
		      modified: modified,
		      removed: removed};

	let modifiedNames = [];

	let latestComponentMap = latestBuildSnapshot.getComponentMap();
	let previousComponentMap = previousBuildSnapshot.getComponentMap();
	for (let componentName in latestComponentMap) {
	    let componentA = latestBuildSnapshot.getComponent(componentName);
	    let componentB = previousBuildSnapshot.getComponent(componentName, true);

	    if (componentB === null)
		added.push(componentName);
	    else if (componentB.revision != componentA.revision)
		modifiedNames.push(componentName);
	}
	for (let componentName in previousComponentMap) {
	    let componentA = latestBuildSnapshot.getComponent(componentName, true);

	    if (componentA === null)
		removed.push(componentName);
	}
	
	for (let i = 0; i < modifiedNames.length; i++) {
	    let componentName = modifiedNames[i];
	    let latestComponent = latestBuildSnapshot.getComponent(componentName);
	    let previousComponent = previousBuildSnapshot.getComponent(componentName);
	    let latestRevision = latestComponent.revision;
	    let previousRevision = previousComponent.revision;
	    let mirrordir = Vcs.ensureVcsMirror(this.mirrordir, previousComponent, cancellable);
	    
	    let gitlog = this._gitLogToJson(mirrordir, previousRevision + '...' + latestRevision);
	    let diffstat = this._diffstat(mirrordir, previousRevision + '..' + latestRevision);
	    modified.push({ previous: previousComponent,
			    latest: latestComponent,
			    gitlog: gitlog,
			    diffstat: diffstat });
	}

	let bdiffdb = this._getResultDb('bdiff'); 
	bdiffdb.store(result, cancellable);
    }
});
