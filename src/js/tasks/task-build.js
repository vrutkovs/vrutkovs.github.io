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
const Format = imports.format;

const GSystem = imports.gi.GSystem;

const Task = imports.task;
const Params = imports.params;
const FileUtil = imports.fileutil;
const AsyncUtil = imports.asyncutil;
const ProcUtil = imports.procutil;
const StreamUtil = imports.streamutil;
const JsonUtil = imports.jsonutil;
const JsonDB = imports.jsondb;
const Snapshot = imports.snapshot;
const BuildUtil = imports.buildutil;
const Vcs = imports.vcs;

const OPT_COMMON_CFLAGS = {'i686': '-O2 -g -m32 -march=i686 -mtune=atom -fasynchronous-unwind-tables',
                           'x86_64': '-O2 -g -m64 -mtune=generic'};

const DEVEL_DIRS = ['usr/include', 'usr/share/aclocal',
		    'usr/share/pkgconfig', 'usr/lib/pkgconfig'];
const DOC_DIRS = ['usr/share/doc', 'usr/share/gtk-doc',
		  'usr/share/man', 'usr/share/info'];

const TaskBuild = new Lang.Class({
    Name: "TaskBuild",
    Extends: Task.Task,

    TaskDef: {
        TaskName: "build",
        TaskAfter: ['resolve'],
    },

    DefaultParameters: {forceComponents: []},

    _resolveRefs: function(refs) {
        if (refs.length == 0)
            return [];
        let args = ['ostree', '--repo=' + this.repo.get_path(), 'rev-parse']
        args.push.apply(args, refs);
        return ProcUtil.runSyncGetOutputLines(args, null);
    },

    _cleanStaleBuildroots: function(buildrootCachedir, keepRoot, cancellable) {
	let direnum = buildrootCachedir.enumerate_children("standard::*,unix::mtime",
							   Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
	let finfo;
	while ((finfo = direnum.next_file(cancellable)) != null) {
	    let child = buildrootCachedir.get_child(finfo.get_name());
	    if (child.equal(keepRoot))
		continue;
            print("Removing old cached buildroot " + child.get_path());
            GSystem.shutil_rm_rf(child, cancellable);
	}
	direnum.close(cancellable);
    },

    _composeBuildrootCore: function(workdir, componentName, architecture, rootContents, cancellable) {
        let starttime = GLib.DateTime.new_now_utc();

        let buildname = Format.vprintf('%s/%s/%s', [this.osname, componentName, architecture]);
        let buildrootCachedir = this.cachedir.resolve_relative_path('roots/' + buildname);
        GSystem.file_ensure_directory(buildrootCachedir, true, cancellable);

	let refsToResolve = []
	for (let i = 0; i < rootContents.length; i++) {
	    refsToResolve.push(rootContents[i][0]);
	}

        let resolvedRefs = this._resolveRefs(refsToResolve);
        let refToRev = {};
	for (let i = 0; i < refsToResolve.length; i++) {
	    refToRev[refsToResolve[i]] = resolvedRefs[i];
	}

        let toChecksumData = '';

	let creds = new Gio.Credentials();
        let uid = creds.get_unix_user();
        let gid = creds.get_unix_user();
        let etcPasswd = Format.vprintf('root:x:0:0:root:/root:/bin/bash\nbuilduser:x:%d:%d:builduser:/:/bin/bash\n', [uid, gid]);
        let etcGroup = Format.vprintf('root:x:0:root\nbuilduser:x:%d:builduser\n', [gid]);

	toChecksumData += etcPasswd;
	toChecksumData += etcGroup;

	let [tmpPath, stream] = Gio.File.new_tmp("ostbuild-buildroot-XXXXXX.txt");
	let dataOut = Gio.DataOutputStream.new(stream.get_output_stream());
	for (let i = 0; i < rootContents.length; i++) {
	    let [branch, subpath] = rootContents[i];
	    let rev = refToRev[branch];
	    toChecksumData += refToRev[branch];
	    dataOut.put_string(refToRev[branch], cancellable);
	    dataOut.put_byte(0, cancellable);
	    dataOut.put_string(subpath, cancellable);
	    dataOut.put_byte(0, cancellable);
	}
        dataOut.close(cancellable);

	let newRootCacheid = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, new GLib.Bytes(toChecksumData));

        let cachedRoot = buildrootCachedir.get_child(newRootCacheid);
        if (cachedRoot.query_exists(cancellable)) {
            print("Reusing cached buildroot: " + cachedRoot.get_path());
            this._cleanStaleBuildroots(buildrootCachedir, cachedRoot, cancellable);
            GSystem.file_unlink(tmpPath, cancellable);
            return cachedRoot;
	}

        if (rootContents.length > 0) {
            print(Format.vprintf("composing buildroot from %d parents (last: %s)", [rootContents.length,
										    rootContents[rootContents.length-1][0]]));
	}

        let cachedRootTmp = cachedRoot.get_parent().get_child(cachedRoot.get_basename() + '.tmp');
	GSystem.shutil_rm_rf(cachedRootTmp, cancellable);
        ProcUtil.runSync(['ostree', '--repo=' + this.repo.get_path(),
			  'checkout', '--user-mode', '--union',
			  '--from-file=' + tmpPath.get_path(), cachedRootTmp.get_path()], cancellable);
        GSystem.file_unlink(tmpPath, cancellable);
	
	this._runTriggersInRoot(cachedRootTmp, cancellable);

        let builddirTmp = cachedRootTmp.get_child('ostbuild');
        GSystem.file_ensure_directory(builddirTmp.resolve_relative_path('source/' + componentName), true, cancellable);
	GSystem.file_ensure_directory(builddirTmp.get_child('results'), true, cancellable);
	cachedRootTmp.resolve_relative_path('etc/passwd').replace_contents(etcPasswd, null, false,
									   Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
	cachedRootTmp.resolve_relative_path('etc/group').replace_contents(etcGroup, null, false,
									  Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
        GSystem.file_rename(cachedRootTmp, cachedRoot, cancellable);

        this._cleanStaleBuildroots(buildrootCachedir, cachedRoot, cancellable);

        let endtime = GLib.DateTime.new_now_utc();
        print(Format.vprintf("Composed buildroot; %d seconds elapsed", [endtime.difference(starttime) / GLib.USEC_PER_SEC]));
        return cachedRoot;

    }, 

    _composeBuildroot: function(workdir, componentName, architecture, cancellable) {
        let components = this._snapshot.data['components']
        let component = null;
        let buildDependencies = [];
        for (let i = 0; i < components.length; i++) {
	    let component = components[i];
            if (component['name'] == componentName)
                break;
            buildDependencies.push(component);
	}

        let archBuildrootName = Format.vprintf('%s/bases/%s/%s-devel', [this.osname,
									this._snapshot.data['base']['name'],
									architecture]);

        print("Computing buildroot contents");

        let archBuildrootRev = ProcUtil.runSyncGetOutputUTF8Stripped(['ostree', '--repo=' + this.repo.get_path(), 'rev-parse',
								      archBuildrootName], cancellable);

        let rootContents = [[archBuildrootName, '/']];
        for (let i = 0; i < buildDependencies.length; i++) {
	    let dependency = buildDependencies[i];
            let buildname = Format.vprintf('%s/components/%s/%s', [this.osname, dependency['name'], architecture]);
            rootContents.push([buildname, '/runtime']);
            rootContents.push([buildname, '/devel']);
	}

	return this._composeBuildrootCore(workdir, componentName, architecture, rootContents, cancellable);
     },

    _analyzeBuildFailure: function(t, architecture, component, componentSrcdir,
				   currentVcsVersion, previousVcsVersion,
				   cancellable) {
        let dataIn = Gio.DataInputStream.new(t.logfile_path.read(cancellable));
        let lines = StreamUtil.dataInputStreamReadLines(dataIn, cancellable);
        dataIn.close(cancellable);
	let maxLines = 250;
	lines = lines.splice(Math.max(0, lines.length-maxLines), maxLines);
        for (let i = 0; i < lines.length; i++) {
            print("| " + lines[i]);
	}
        if (currentVcsVersion && previousVcsVersion) {
            let args = ['git', 'log', '--format=short'];
            args.push(previousVcsVersion + '...' + currentVcsVersion);
            let env = GLib.get_environ();
            env.push('GIT_PAGER=cat');
	    ProcUtil.runSync(args, cancellable, {cwd: componentSrcdir,
						 env: env});
        } else {
            print("No previous build; skipping source diff");
	}
     },

    _compareAny: function(a, b) {
	if (typeof(a) == 'string') {
	    return a == b;
	} else if (a.length != undefined) {
	    if (a.length != b.length)
		return false;
	    for (let i = 0; i < a.length; i++) {
		if (a[i] != b[i]) {
		    return false;
		}
	    }
	} else {
	    for (let k in a) {
		if (b[k] != a[k])
		    return false;
	    }
	    for (let k in b) {
		if (a[k] == undefined)
		    return false;
	    }
	}
	return true;
    },

    _needsRebuild: function(previousMetadata, newMetadata) {
        let buildKeys = ['config-opts', 'src', 'revision', 'setuid'];
        for (let i = 0; i < buildKeys.length; i++) {
	    let k = buildKeys[i];
            if (previousMetadata[k] && !newMetadata[k]) {
                return 'key ' + k + ' removed';
	    } else if (!previousMetadata[k] && newMetadata[k]) {
                return 'key ' + k + ' added';
	    } else if (previousMetadata[k] && newMetadata[k]) {
                let oldval = previousMetadata[k];
                let newval = newMetadata[k];
                if (!this._compareAny(oldval,newval)) {
                    return Format.vprintf('key %s differs (%s -> %s)', [k, oldval, newval]);
		}
	    }
	}
            
        if (previousMetadata['patches']) {
            if (!newMetadata['patches']) {
                return 'patches differ';
	    }
            let oldPatches = previousMetadata['patches'];
            let newPatches = newMetadata['patches'];
            let oldFiles = oldPatches['files'];
            let newFiles = newPatches['files'];
            if (oldFiles.length != newFiles.length) {
                return 'patches differ';
	    }
            let oldSha256sums = oldPatches['files_sha256sums'];
            let newSha256sums = newPatches['files_sha256sums'];
            if ((!oldSha256sums || !newSha256sums) ||
                !this._compareAny(oldSha256sums, newSha256sums)) {
                return 'patch sha256sums differ';
	    }
	} else if (newMetadata['patches']) {
	    return 'patches differ';
	}
        return null;
    },

    _computeSha256SumsForPatches: function(patchdir, component, cancellable) {
        let patches = BuildUtil.getPatchPathsForComponent(patchdir, component);
        let result = [];
        for (let i = 0; i < patches.length; i++) {
	    let contentsBytes = GSystem.file_map_readonly(patches[i], cancellable);
	    let csum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256,
						       contentsBytes);
            result.push(csum);
	}
        return result;
    },

    _writeComponentCache: function(key, data, cancellable) {
        this._componentBuildCache[key] = data;
        JsonUtil.writeJsonFileAtomic(this._componentBuildCachePath, this._componentBuildCache, cancellable);
    },

    _saveComponentBuild: function(buildRef, expandedComponent, cancellable) {
	let cachedata = {};
	Lang.copyProperties(expandedComponent, cachedata);
        cachedata['ostree'] = ProcUtil.runSyncGetOutputUTF8Stripped(['ostree', '--repo=' + this.repo.get_path(),
								     'rev-parse', buildRef], cancellable);
	this._writeComponentCache(buildRef, cachedata, cancellable);
        return cachedata['ostree'];
    },

    _installAndUnlinkRecurse: function(buildResultDir, srcFile, srcInfo, finalResultDir, cancellable) {
	let relpath = buildResultDir.get_relative_path(srcFile);
	let destFile;
	if (relpath === null)
	    destFile = finalResultDir;
	else
	    destFile = finalResultDir.resolve_relative_path(relpath);

	GSystem.file_ensure_directory(destFile.get_parent(), true, cancellable);
	
	if (srcInfo.get_file_type() == Gio.FileType.DIRECTORY) {
	    GSystem.file_ensure_directory(destFile, true, cancellable);
	    let e = srcFile.enumerate_children('standard::*,unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
	    let info;
	    while ((info = e.next_file(cancellable)) !== null) {
		let child = e.get_child(info);
		this._installAndUnlinkRecurse(buildResultDir, child, info, finalResultDir, cancellable);
	    }
	    e.close(cancellable);
	    srcFile.delete(cancellable);
	} else {
	    GSystem.file_linkcopy(srcFile, destFile, Gio.FileCopyFlags.ALL_METADATA, cancellable);
	    GSystem.file_unlink(srcFile, cancellable);
	} 
    },

    _installAndUnlink: function(buildResultDir, srcFile, finalResultDir, cancellable) {
	let srcInfo = srcFile.query_info('standard::*,unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
	this._installAndUnlinkRecurse(buildResultDir, srcFile, srcInfo, finalResultDir, cancellable);
    },

    _processBuildResultSplitDebuginfo: function(buildResultDir, debugPath, path, cancellable) {
	let name = path.get_basename();
	// Only process files ending in .so.* or executables
	let soRegex = /\.so\./;
	if (!soRegex.exec(name)) {
	    let finfo = path.query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
					cancellable);
	    let mode = finfo.get_attribute_uint32('unix::mode');
	    if (!(mode & 73))
		return;
	}
	let elfSharedRe = /ELF.*shared/;
	let elfExecRe = /ELF.*executable/;
	let ftype = ProcUtil.runSyncGetOutputUTF8StrippedOrNull(['file', path.get_path()], cancellable);
	if (ftype == null)
	    return;

	let isShared = elfSharedRe.test(ftype);
	let isExec = elfExecRe.test(ftype);

	if (!(isShared || isExec))
	    return;

	let buildIdPattern = /\s+Build ID: ([0-9a-f]+)/;
	let match = ProcUtil.runSyncGetOutputGrep(['eu-readelf', '-n', path.get_path()], buildIdPattern, cancellable);
	if (match == null) {
	    print("WARNING: no build-id for ELF object " + path.get_path());
	    return;
	} 
	let buildId = match[1];
	print("ELF object " + path.get_path() + " buildid=" + buildId);
	let dbgName = buildId[0] + buildId[1] + '/' + buildId.substr(2) + '.debug';
	let objdebugPath = debugPath.resolve_relative_path('usr/lib/debug/.build-id/' + dbgName);
	GSystem.file_ensure_directory(objdebugPath.get_parent(), true, cancellable);
	ProcUtil.runSync(['objcopy', '--only-keep-debug', path.get_path(), objdebugPath.get_path()], cancellable);

	let stripArgs = ['strip', '--remove-section=.comment', '--remove-section=.note']; 
	if (isShared) {
	    stripArgs.push('--strip-unneeded');
	}
	stripArgs.push(path.get_path());
	ProcUtil.runSync(stripArgs, cancellable);
    },
    
    _processBuildResults: function(component, buildResultDir, finalResultDir, cancellable) {
	let runtimePath = finalResultDir.get_child('runtime');
	GSystem.file_ensure_directory(runtimePath, true, cancellable);
	let develPath = finalResultDir.get_child('devel');
	GSystem.file_ensure_directory(develPath, true, cancellable);
	let docPath = finalResultDir.get_child('doc');
	GSystem.file_ensure_directory(docPath, true, cancellable);
	let debugPath = finalResultDir.get_child('debug');
	GSystem.file_ensure_directory(debugPath, true, cancellable);
	let testsPath = finalResultDir.get_child('tests');
	GSystem.file_ensure_directory(testsPath, true, cancellable);

	// Change file modes first; some components install files that
	// are read-only even by the user, which we don't want.
	FileUtil.walkDir(buildResultDir, {}, Lang.bind(this, function(path, cancellable) {
	    let info = path.query_info("standard::type,unix::mode", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
	    if (info.get_file_type() != Gio.FileType.SYMBOLIC_LINK) {
		let minimalMode = 436; // u+rw,g+rw,o+r
		if (info.get_file_type() == Gio.FileType.DIRECTORY)
		    minimalMode |= 64; // u+x
		let mode = info.get_attribute_uint32('unix::mode');
		GSystem.file_chmod(path, mode | minimalMode, cancellable);
	    }
	}), cancellable);

	let datadir = buildResultDir.resolve_relative_path('usr/share');
	let localstatedir = buildResultDir.get_child('var');
	let libdir = buildResultDir.resolve_relative_path('usr/lib');
	let libexecdir = buildResultDir.resolve_relative_path('usr/libexec');

	// Remove /var from the install - components are required to
	// auto-create these directories on demand.
	GSystem.shutil_rm_rf(localstatedir, cancellable);

	// Python .co files contain timestamps
	// .la files are generally evil
	let DELETE_PATTERNS = [{ nameRegex: /\.(py[co])|(la)$/ },
			       { nameRegex: /\.la$/,
				 fileType: Gio.FileType.REGULAR }];
			       
	for (let i = 0; i < DELETE_PATTERNS.length; i++) {
	    let pattern = DELETE_PATTERNS[i];
	    FileUtil.walkDir(buildResultDir, pattern,
			     Lang.bind(this, function(filePath, cancellable) {
				 GSystem.file_unlink(filePath, cancellable);
			     }), cancellable);
	}

	if (libdir.query_exists(null)) {
	    // Move symbolic links for shared libraries to devel
	    FileUtil.walkDir(libdir, { nameRegex: /\.so$/,
				       fileType: Gio.FileType.SYMBOLIC_LINK,
				       depth: 1 },
			     Lang.bind(this, function(filePath, cancellable) {
				 this._installAndUnlink(buildResultDir, filePath, develPath, cancellable);
			     }), cancellable);
	    // Just delete static libraries.  No one should use them.
	    FileUtil.walkDir(libdir, { nameRegex: /\.a$/,
				       fileType: Gio.FileType.REGULAR,
				       depth: 1 },
			     Lang.bind(this, function(filePath, cancellable) {
				 GSystem.file_unlink(filePath, cancellable);
			     }), cancellable);
	}

	FileUtil.walkDir(buildResultDir, { fileType: Gio.FileType.REGULAR },
			 Lang.bind(this, function(filePath, cancellable) {
			     this._processBuildResultSplitDebuginfo(buildResultDir, debugPath, filePath, cancellable);
			 }), cancellable);

	for (let i = 0; i < DEVEL_DIRS.length; i++) {
	    let path = DEVEL_DIRS[i];
	    let oneDevelDir = buildResultDir.resolve_relative_path(path);
	    
	    if (oneDevelDir.query_exists(null)) {
		this._installAndUnlink(buildResultDir, oneDevelDir, develPath, cancellable);
	    }
	}

	for (let i = 0; i < DOC_DIRS.length; i++) {
	    let path = DOC_DIRS[i];
	    let oneDocDir = buildResultDir.resolve_relative_path(path);
	    
	    if (oneDocDir.query_exists(null)) {
		this._installAndUnlink(buildResultDir, oneDocDir, docPath, cancellable);
	    }
	}

	let installedTestFiles = datadir.get_child('installed-tests');
	if (installedTestFiles.query_exists(null)) {
	    this._installAndUnlink(buildResultDir, installedTestFiles, testsPath, cancellable);
	    
	    let installedTestsDataSubdir = null;
	    if (libexecdir.query_exists(null)) {
		let topInstTestsPath = libexecdir.get_child('installed-tests');
		if (topInstTestsPath.query_exists(null)) {
		    installedTestsDataSubdir = topInstTestsPath;
		} else { 
		    FileUtil.walkDir(libexecdir, {fileType: Gio.FileType.DIRECTORY,
						  depth: 1 },
				     Lang.bind(this, function(filePath, cancellable) {
					 let pkgInstTestsPath = filePath.get_child('installed-tests');
					 if (!pkgInstTestsPath.query_exists(null))
					     return;
					 // At the moment we only support one installed tests data
					 if (installedTestsDataSubdir == null)
					     installedTestsDataSubdir = pkgInstTestsPath;
				     }), cancellable);
		}
	    }
	    if (installedTestsDataSubdir)
		this._installAndUnlink(buildResultDir, installedTestsDataSubdir, testsPath, cancellable);
	}

	this._installAndUnlink(buildResultDir, buildResultDir, runtimePath, cancellable);
    },

    _onBuildComplete: function(taskset, success, msg, loop) {
	this._currentBuildSucceded = success;
	this._currentBuildSuccessMsg = msg;
	loop.quit();
    },

    _componentBuildRefFromName: function(componentName, architecture) {
        let archBuildname = Format.vprintf('%s/%s', [componentName, architecture]);
        return this.osname + '/components/' + archBuildname;
    },

    _componentBuildRef: function(component, architecture) {
	return this._componentBuildRefFromName(component['name'], architecture);
    },
    
    _buildOneComponent: function(component, architecture, cancellable, params) {
	params = Params.parse(params, { installedTests: false });
        let basename = component['name'];

	if (params.installedTests)
	    basename = basename + '-installed-tests';
        let archBuildname = Format.vprintf('%s/%s', [basename, architecture]);
        let unixBuildname = archBuildname.replace(/\//g, '_');
        let buildRef = this._componentBuildRefFromName(basename, architecture);

        let currentVcsVersion = component['revision'];
        let expandedComponent = this._snapshot.getExpanded(component['name']);
        let previousMetadata = this._componentBuildCache[buildRef];
	let previousBuildVersion = null;
	let previousVcsVersion = null;
        if (previousMetadata != null) {
            previousBuildVersion = previousMetadata['ostree'];
            previousVcsVersion = previousMetadata['revision'];
        } else {
            print("No previous build for " + archBuildname);
	}

	let patchdir;
        if (expandedComponent['patches']) {
            let patchesRevision = expandedComponent['patches']['revision'];
            if (this._cachedPatchdirRevision == patchesRevision) {
                patchdir = this.patchdir;
            } else {
                patchdir = Vcs.checkoutPatches(this.mirrordir,
                                               this.patchdir,
                                               expandedComponent,
					       cancellable);
		this.patchdir = patchdir;
                this._cachedPatchdirRevision = patchesRevision;
	    }
            if ((previousMetadata != null) &&
                previousMetadata['patches'] &&
                previousMetadata['patches']['src'].indexOf('local:') != 0 &&
                previousMetadata['patches']['revision'] &&
                previousMetadata['patches']['revision'] == patchesRevision) {
                // Copy over the sha256sums
                expandedComponent['patches'] = previousMetadata['patches'];
            } else {
                let patchesSha256sums = this._computeSha256SumsForPatches(patchdir, expandedComponent, cancellable);
                expandedComponent['patches']['files_sha256sums'] = patchesSha256sums;
	    }
        } else {
            patchdir = null;
	}

        let forceRebuild = (this.forceBuildComponents[basename] ||
                            expandedComponent['src'].indexOf('local:') == 0);

        if (previousMetadata != null) {
            let rebuildReason = this._needsRebuild(previousMetadata, expandedComponent);
            if (rebuildReason == null) {
                if (!forceRebuild) {
                    print(Format.vprintf("Reusing cached build of %s at %s", [archBuildname, previousVcsVersion]));
                    return previousBuildVersion;
                } else {
                    print("Build forced regardless");
		}
            } else {
                print(Format.vprintf("Need rebuild of %s: %s", [archBuildname, rebuildReason]));
	    }
	}

	let cwd = Gio.File.new_for_path('.');
	let buildWorkdir = cwd.get_child('tmp-' + unixBuildname);
	GSystem.file_ensure_directory(buildWorkdir, true, cancellable);

        let tempMetadataPath = buildWorkdir.get_child('_ostbuild-meta.json');
        JsonUtil.writeJsonFileAtomic(tempMetadataPath, expandedComponent, cancellable);

        let componentSrc = buildWorkdir.get_child(basename);
        let childArgs = ['ostbuild', 'checkout', '--snapshot=' + this._snapshot.path.get_path(),
			 '--workdir=' + this.workdir.get_path(),
			 '--checkoutdir=' + componentSrc.get_path(),
			 '--metadata-path=' + tempMetadataPath.get_path(),
			 '--overwrite', basename];
        if (patchdir) {
            childArgs.push('--patches-path=' + patchdir.get_path());
	}
        ProcUtil.runSync(childArgs, cancellable, { logInitiation: true });

        GSystem.file_unlink(tempMetadataPath, cancellable);

        let componentResultdir = buildWorkdir.get_child('results');
        GSystem.file_ensure_directory(componentResultdir, true, cancellable);

	let rootdir;
	if (params.installedTests)
	    rootdir = this._composeBuildrootCore(buildWorkdir, basename, architecture,
						 [[this._installedTestsBuildrootRev[architecture], '/']], cancellable);
	else
            rootdir = this._composeBuildroot(buildWorkdir, basename, architecture, cancellable);

        let tmpdir=buildWorkdir.get_child('tmp');
        GSystem.file_ensure_directory(tmpdir, true, cancellable);

        let srcCompileOnePath = this.libdir.get_child('ostree-build-compile-one');
        let destCompileOnePath = rootdir.get_child('ostree-build-compile-one');
	srcCompileOnePath.copy(destCompileOnePath, Gio.FileCopyFlags.OVERWRITE,
			       cancellable, null);
        GSystem.file_chmod(destCompileOnePath, 493, cancellable);

        let chrootSourcedir = Gio.File.new_for_path('/ostbuild/source/' + basename);
	let chrootChdir = chrootSourcedir;

	let installedTestsSrcdir = componentSrc.get_child('installed-tests');
	if (params.installedTests) {
	    // We're just building the tests, set our source directory
	    let metaName = '_ostbuild-meta.json';
	    GSystem.file_rename(componentSrc.get_child(metaName), installedTestsSrcdir.get_child(metaName), cancellable);
	    chrootChdir = chrootSourcedir.get_child('installed-tests');
	    if (!componentSrc.query_exists(null)) {
		throw new Error("Component " + basename + " specified with installed tests, but no subdirectory found");
	    }
	}

        childArgs = ['setarch', architecture];
        childArgs.push.apply(childArgs, BuildUtil.getBaseUserChrootArgs());
        childArgs.push.apply(childArgs, [
            '--mount-readonly', '/',
            '--mount-bind', '/', '/sysroot',
            '--mount-proc', '/proc', 
            '--mount-bind', '/dev', '/dev',
            '--mount-bind', componentSrc.get_path(), chrootSourcedir.get_path(),
            '--mount-bind', componentResultdir.get_path(), '/ostbuild/results',
            '--chdir', chrootChdir.get_path(),
            rootdir.get_path(), '/ostree-build-compile-one',
            '--ostbuild-resultdir=/ostbuild/results',
            '--ostbuild-meta=_ostbuild-meta.json']);
	let envCopy = {};
	Lang.copyProperties(BuildUtil.BUILD_ENV, envCopy);
        envCopy['PWD'] = chrootSourcedir.get_path();
        envCopy['CFLAGS'] = OPT_COMMON_CFLAGS[architecture];
        envCopy['CXXFLAGS'] = OPT_COMMON_CFLAGS[architecture];

	let context = new GSystem.SubprocessContext({ argv: childArgs });
	context.set_environment(ProcUtil.objectToEnvironment(envCopy));
	
	let proc = new GSystem.Subprocess({ context: context });
	proc.init(cancellable);
	print("Started child process " + context.argv.map(GLib.shell_quote).join(' '));
	try {
	    proc.wait_sync_check(cancellable);
	} catch (e) {
	    print("Build of " + basename + " failed");
	    throw e;
	}

	let finalBuildResultDir = buildWorkdir.get_child('post-results');
	GSystem.shutil_rm_rf(finalBuildResultDir, cancellable);
        GSystem.file_ensure_directory(finalBuildResultDir, true, cancellable);

	this._processBuildResults(component, componentResultdir, finalBuildResultDir, cancellable);

        let recordedMetaPath = finalBuildResultDir.get_child('_ostbuild-meta.json');
        JsonUtil.writeJsonFileAtomic(recordedMetaPath, expandedComponent, cancellable);

        let commitArgs = ['ostree', '--repo=' + this.repo.get_path(),
			  'commit', '-b', buildRef, '-s', 'Build',
			  '--owner-uid=0', '--owner-gid=0', '--no-xattrs', 
			  '--skip-if-unchanged'];

        let setuidFiles = expandedComponent['setuid'] || [];
        let statoverridePath = null;
        if (setuidFiles.length > 0) {
	    let [statoverridePath, stream] = Gio.File.new_tmp("ostbuild-statoverride-XXXXXX.txt");
	    let dataOut = Gio.DataOutputStream.new(stream.get_output_stream());
	    for (let i = 0; i < setuidFiles.length; i++) {
		dataOut.put_string("+2048 ", cancellable);
		dataOut.put_string(setuidFiles[i], cancellable);
		dataOut.put_string("\n", cancellable);
	    }
            dataOut.close(cancellable);
            commitArgs.push('--statoverride=' + statoverridePath.get_path());
	}

        ProcUtil.runSync(commitArgs, cancellable, {cwd: finalBuildResultDir,
						   logInitiation: true});
        if (statoverridePath != null)
            GSystem.file_unlink(statoverridePath, cancellable);

        GSystem.shutil_rm_rf(buildWorkdir, cancellable);

        let ostreeRevision = this._saveComponentBuild(buildRef, expandedComponent, cancellable);

	this._rebuiltComponents.push(basename);

        return ostreeRevision;
    },
    
    _checkoutOneTreeCoreAsync: function(name, composeContents, cancellable, callback,
					params) {
	params = Params.parse(params, { runTriggers: true });
        let composeRootdir = this.subworkdir.get_child(name);
	print("Checking out " + composeRootdir.get_path());
	GSystem.shutil_rm_rf(composeRootdir, cancellable);
        GSystem.file_ensure_directory(composeRootdir, true, cancellable);

	let [contentsTmpPath, stream] = Gio.File.new_tmp("ostbuild-compose-XXXXXX.txt");
	let dataOut = Gio.DataOutputStream.new(stream.get_output_stream());
	for (let i = 0; i < composeContents.length; i++) {
	    let [branch, subpath] = composeContents[i];
            dataOut.put_string(branch, cancellable);
	    dataOut.put_byte(0, cancellable);
            dataOut.put_string(subpath, cancellable);
	    dataOut.put_byte(0, cancellable);
	}
        dataOut.close(cancellable);

	let argv = ['ostree', '--repo=' + this.repo.get_path(),
		    'checkout', '--allow-noent', '--user-mode', '--union', 
		    '--from-file=' + contentsTmpPath.get_path(), composeRootdir.get_path()];
	print("Running: " + argv.map(GLib.shell_quote).join(' '));
	let proc = GSystem.Subprocess.new_simple_argv(argv,
						      GSystem.SubprocessStreamDisposition.INHERIT,
						      GSystem.SubprocessStreamDisposition.INHERIT,
						      cancellable);
	proc.wait(cancellable, Lang.bind(this, function(proc, result) {
            GSystem.file_unlink(contentsTmpPath, cancellable);
	    let [success, ecode] = proc.wait_finish(result);
	    try {
		GLib.spawn_check_exit_status(ecode);
	    } catch (e) {
		callback(null, ""+e);
		return;
	    }

	    if (params.runTriggers)
		this._runTriggersInRoot(composeRootdir, cancellable);
	    
            let contentsPath = composeRootdir.resolve_relative_path('usr/share/contents.json');
	    GSystem.file_ensure_directory(contentsPath.get_parent(), true, cancellable);
            JsonUtil.writeJsonFileAtomic(contentsPath, this._snapshot.data, cancellable);

	    callback(composeRootdir, null);
	}));
    },

    _checkoutOneTreeAsync: function(target, componentBuildRevs, cancellable, callback) {
        let base = target['base'];
        let baseName = this.osname + '/bases/' + base['name'];
        let runtimeName = this.osname +'/bases/' + base['runtime'];
        let develName = this.osname + '/bases/' + base['devel'];

        let relatedRefs = {};
        let baseRevision = ProcUtil.runSyncGetOutputUTF8Stripped(['ostree', '--repo=' + this.repo.get_path(),
								  'rev-parse', baseName], cancellable);

        let runtimeRevision = ProcUtil.runSyncGetOutputUTF8Stripped(['ostree', '--repo=' + this.repo.get_path(),
								     'rev-parse', runtimeName], cancellable);
        relatedRefs[runtimeName] = runtimeRevision;
        let develRevision = ProcUtil.runSyncGetOutputUTF8Stripped(['ostree', '--repo=' + this.repo.get_path(),
								   'rev-parse', develName], cancellable);
        relatedRefs[develName] = develRevision;

	for (let name in componentBuildRevs) {
	    let rev = componentBuildRevs[name];
            let buildRef = this.osname + '/components/' + name;
            relatedRefs[buildRef] = rev;
	}

	let [relatedTmpPath, stream] = Gio.File.new_tmp("ostbuild-compose-XXXXXX.txt");
	let dataOut = Gio.DataOutputStream.new(stream.get_output_stream());
	for (let name in relatedRefs) {
	    let rev = relatedRefs[name];
	    dataOut.put_string(name, cancellable);
	    dataOut.put_string(' ', cancellable);
	    dataOut.put_string(rev, cancellable);
	    dataOut.put_string('\n', cancellable);
	}
	dataOut.close(cancellable);

        let composeContents = [[baseRevision, '/']];
        for (let i = 0; i < target['contents'].length; i++) {
	    let treeContent = target['contents'][i];
            let name = treeContent['name'];
            let rev = componentBuildRevs[name];
            let subtrees = treeContent['trees'];
            for (let j = 0; j < subtrees.length; j++) {
		let subpath = subtrees[j];
                composeContents.push([rev, subpath]);
	    }
	}

	this._checkoutOneTreeCoreAsync(target['name'], composeContents, cancellable,
				       Lang.bind(this, function(result, err) {
					   if (err) {
					       callback(null, err);
					       return;
					   } else {
					       let composeRootdir = result;
					       
					       this._postComposeTransform(composeRootdir, cancellable);
					       callback([composeRootdir, relatedTmpPath], null);
					   }
				       }));
    },
    
    _runTriggersInRoot: function(rootdir, cancellable) {
	let triggersScriptPath = this.libdir.resolve_relative_path('gnome-ostree-run-triggers');
	let triggersPath = this.libdir.resolve_relative_path('triggers');
	let childArgs = BuildUtil.getBaseUserChrootArgs();
        childArgs.push.apply(childArgs, [
	    '--mount-bind', '/', '/sysroot',
            '--mount-proc', '/proc', 
            '--mount-bind', '/dev', '/dev',
            rootdir.get_path(), '/sysroot' + triggersScriptPath.get_path(),
	    '/sysroot' + triggersPath.get_path()]);
	let envCopy = {};
	Lang.copyProperties(BuildUtil.BUILD_ENV, envCopy);
        envCopy['PWD'] = '/';

	let context = new GSystem.SubprocessContext({ argv: childArgs });
	context.set_environment(ProcUtil.objectToEnvironment(envCopy));
	let proc = new GSystem.Subprocess({ context: context });
	proc.init(cancellable);
	print("Started child process " + context.argv.map(GLib.shell_quote).join(' '));
	try {
	    proc.wait_sync_check(cancellable);
	} catch (e) {
	    print("Trigger execution in root " + rootdir.get_path() + " failed");
	    throw e;
	}
    },

    _postComposeTransform: function(composeRootdir, cancellable) {
	// Move /etc to /usr/etc, since it contains defaults.
	let etc = composeRootdir.resolve_relative_path("etc");
	let usrEtc = composeRootdir.resolve_relative_path("usr/etc");
	GSystem.file_rename(etc, usrEtc, cancellable);
    },
    
    _commitComposedTreeAsync: function(targetName, composeRootdir, relatedTmpPath, cancellable, callback) {
        let treename = this.osname + '/' + targetName;
	let args = ['ostree', '--repo=' + this.repo.get_path(),
		    'commit', '-b', treename, '-s', 'Compose',
		    '--owner-uid=0', '--owner-gid=0', '--no-xattrs',
		    '--skip-if-unchanged'];
	if (relatedTmpPath !== null)
	    args.push('--related-objects-file=' + relatedTmpPath.get_path());

	let membuf = Gio.MemoryOutputStream.new_resizable();

	let asyncSet = new AsyncUtil.AsyncSet(Lang.bind(this, function(results, err) {
	    if (relatedTmpPath !== null)
		GSystem.file_unlink(relatedTmpPath, cancellable);
            GSystem.shutil_rm_rf(composeRootdir, cancellable);
	    if (err) {
		callback(null, err);
		return;
	    }
	    let revision = membuf.steal_as_bytes().toArray().toString();
	    revision = revision.replace(/[ \n]+$/, '');
	    print("Compose of " + targetName + " is " + revision);
	    callback([treename, revision], null);

	}), cancellable);
	print("Running: " + args.map(GLib.shell_quote).join(' '));
	let context = new GSystem.SubprocessContext({ argv: args });
	context.set_stdout_disposition(GSystem.SubprocessStreamDisposition.PIPE);
	context.set_cwd(composeRootdir.get_path());
	let proc = new GSystem.Subprocess({ context: context });
	proc.init(cancellable);
	let stdout = proc.get_stdout_pipe();
	membuf.splice_async(stdout,
			    Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
			    GLib.PRIORITY_DEFAULT,
			    cancellable,
			    asyncSet.addGAsyncResult("splice",
						     Lang.bind(this, function(stream, result) {
							 stream.splice_finish(result);
						     })));
	proc.wait(cancellable,
		  asyncSet.addGAsyncResult("wait",
					   Lang.bind(this, function(proc, result) {
					       let [success, ecode] = proc.wait_finish(result);
					       GLib.spawn_check_exit_status(ecode);
					   })));
    },

    // Return a SHA256 checksum of the contents of the kernel and all
    // modules; this is unlike an OSTree checksum in that we're just
    // checksumming the contents, not the uid/gid/xattrs.
    // Unfortunately, we can't rely on those for /boot anyways.
    _getKernelChecksum: function(kernelPath, kernelRelease, composeRootdir, cancellable) {
	let checksum = GLib.Checksum.new(GLib.ChecksumType.SHA256);
	let contents = GSystem.file_map_readonly(kernelPath, cancellable);
	checksum.update(contents.toArray());
	contents = null;
	let modulesPath = composeRootdir.resolve_relative_path('lib/modules/' + kernelRelease);
	if (modulesPath.query_exists(null)) {
	    // Only checksum .ko files; we don't want to pick up the
	    // modules.order file and such that might contain
	    // timestamps.
	    FileUtil.walkDir(modulesPath, { fileType: Gio.FileType.REGULAR,
					    nameRegex: /\.ko$/,
					    sortByName: true },
			     function (child, cancellable) {
				 let contents = GSystem.file_map_readonly(child, cancellable);
				 checksum.update(contents.toArray());
				 contents = null;
			     }, cancellable);
	}
	return checksum.get_string();
    },

    _prepareKernelAndInitramfs: function(architecture, composeRootdir, initramfsDepends, cancellable) {
	let e = composeRootdir.get_child('boot').enumerate_children('standard::*', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
	let info;
	let kernelPath = null;
	while ((info = e.next_file(cancellable)) != null) {
	    let name = info.get_name();
	    if (name.indexOf('vmlinuz-') != 0)
		continue;
	    kernelPath = e.get_child(info);
	    break;
	}
	e.close(cancellable);
	if (kernelPath === null)
	    throw new Error("Couldn't find vmlinuz- in compose root");

	let kernelName = kernelPath.get_basename();
	let releaseIdx = kernelName.indexOf('-');
	let kernelRelease = kernelName.substr(releaseIdx + 1);

	let kernelContentsChecksum = this._getKernelChecksum(kernelPath, kernelRelease, composeRootdir, cancellable);

        let initramfsCachedir = this.cachedir.resolve_relative_path('initramfs/' + architecture);
	GSystem.file_ensure_directory(initramfsCachedir, true, cancellable);

	let initramfsEpoch = this._snapshot.data['initramfs-build-epoch'];
	let initramfsEpochVersion = 0;
	if (initramfsEpoch)
	    initramfsEpochVersion = initramfsEpoch['version'];
	let fullInitramfsDependsString = 'epoch:' + initramfsEpochVersion +
	    ';kernel:' + kernelContentsChecksum + ';' +
	    initramfsDepends.join(';'); 
	let dependsChecksum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256,
							      GLib.Bytes.new(fullInitramfsDependsString));

	let cachedInitramfsDirPath = initramfsCachedir.get_child(dependsChecksum);
	if (cachedInitramfsDirPath.query_file_type(Gio.FileQueryInfoFlags.NONE, null) == Gio.FileType.DIRECTORY) {
	    print("Reusing cached initramfs " + cachedInitramfsDirPath.get_path());
	} else {
	    print("No cached initramfs matching " + fullInitramfsDependsString);

	    // Clean out all old initramfs images
	    GSystem.shutil_rm_rf(initramfsCachedir, cancellable);

	    let cwd = Gio.File.new_for_path('.');
	    let workdir = cwd.get_child('tmp-initramfs-' + architecture);
	    let varTmp = workdir.resolve_relative_path('var/tmp');
	    GSystem.file_ensure_directory(varTmp, true, cancellable);
	    let varDir = varTmp.get_parent();
	    let tmpDir = workdir.resolve_relative_path('tmp');
	    GSystem.file_ensure_directory(tmpDir, true, cancellable);
	    let initramfsTmp = tmpDir.get_child('initramfs-ostree.img');

	    // HACK: Temporarily move /usr/etc to /etc to help dracut
	    // find stuff, like the config file telling it to use the
	    // ostree module.
	    let etcDir = composeRootdir.resolve_relative_path('etc');
	    let usrEtcDir = composeRootdir.resolve_relative_path('usr/etc');
	    GSystem.file_rename(usrEtcDir, etcDir, cancellable);
	    let args = ['linux-user-chroot',
			'--mount-proc', '/proc',
			'--mount-bind', '/dev', '/dev',
			'--mount-bind', '/', '/sysroot',
			'--mount-bind', tmpDir.get_path(), '/sysroot/tmp',
			'--mount-bind', varDir.get_path(), '/var',
			composeRootdir.get_path(),
			'dracut', '--tmpdir=/tmp', '-f', '/tmp/initramfs-ostree.img',
			kernelRelease];
	    
	    print("Running: " + args.map(GLib.shell_quote).join(' '));
	    let context = new GSystem.SubprocessContext({ argv: args });
	    let proc = new GSystem.Subprocess({ context: context });
	    proc.init(cancellable);
	    proc.wait_sync_check(cancellable);

	    // HACK: Move /etc back to /usr/etc
	    GSystem.file_rename(etcDir, usrEtcDir, cancellable);

	    GSystem.file_chmod(initramfsTmp, 420, cancellable);

	    let contents = GSystem.file_map_readonly(initramfsTmp, cancellable);
	    let initramfsContentsChecksum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, contents);
	    contents = null;

	    let tmpCachedInitramfsDirPath = cachedInitramfsDirPath.get_parent().get_child(cachedInitramfsDirPath.get_basename() + '.tmp');
	    GSystem.shutil_rm_rf(tmpCachedInitramfsDirPath, cancellable);
	    GSystem.file_ensure_directory(tmpCachedInitramfsDirPath, true, cancellable);

	    GSystem.file_rename(initramfsTmp, tmpCachedInitramfsDirPath.get_child('initramfs-' + kernelRelease + '-' + initramfsContentsChecksum), cancellable);
	    GSystem.file_linkcopy(kernelPath, tmpCachedInitramfsDirPath.get_child('vmlinuz-' + kernelRelease + '-' + kernelContentsChecksum),
				  Gio.FileCopyFlags.OVERWRITE, cancellable);
	    
	    GSystem.shutil_rm_rf(cachedInitramfsDirPath, cancellable);
	    GSystem.file_rename(tmpCachedInitramfsDirPath, cachedInitramfsDirPath, cancellable);
	}

	let cachedKernelPath = null;
	let cachedInitramfsPath = null;
	FileUtil.walkDir(cachedInitramfsDirPath, { fileType: Gio.FileType.REGULAR },
			 function (child, cancellable) {
			     if (child.get_basename().indexOf('initramfs-') == 0)
				 cachedInitramfsPath = child;
			     else if (child.get_basename().indexOf('vmlinuz-') == 0)
				 cachedKernelPath = child;
			 }, cancellable);
	if (cachedKernelPath == null || cachedInitramfsPath == null)
	    throw new Error("Missing file in " + cachedInitramfsDirPath);
	let cachedInitramfsPathName = cachedInitramfsPath.get_basename();
	let initramfsContentsChecksum = cachedInitramfsPathName.substr(cachedInitramfsPathName.lastIndexOf('-') + 1);

	let ostreeBootChecksum = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256,
								  kernelContentsChecksum + initramfsContentsChecksum,
								  -1);
	
	return { kernelRelease: kernelRelease,
		 kernelPath: cachedKernelPath,
		 kernelChecksum: kernelContentsChecksum,
		 initramfsPath: cachedInitramfsPath,
	         initramfsContentsChecksum: initramfsContentsChecksum,
		 ostreeBootChecksum: ostreeBootChecksum };
    },

    // Clear out the target's /boot directory, and replace it with
    // kernel/initramfs that are named with the same
    // ostreeBootChecksum, derived from individual checksums
    _installKernelAndInitramfs: function(kernelInitramfsData, composeRootdir, cancellable) {
	let bootDir = composeRootdir.get_child('boot');
	GSystem.shutil_rm_rf(bootDir, cancellable);
	GSystem.file_ensure_directory(bootDir, true, cancellable);
	let targetKernelPath = bootDir.get_child('vmlinuz-' + kernelInitramfsData.kernelRelease + '-' + kernelInitramfsData.ostreeBootChecksum);
	GSystem.file_linkcopy(kernelInitramfsData.kernelPath, targetKernelPath, Gio.FileCopyFlags.ALL_METADATA, cancellable);
	let targetInitramfsPath = bootDir.get_child('initramfs-' + kernelInitramfsData.kernelRelease + '-' + kernelInitramfsData.ostreeBootChecksum);
	GSystem.file_linkcopy(kernelInitramfsData.initramfsPath, targetInitramfsPath, Gio.FileCopyFlags.ALL_METADATA, cancellable);
    },

    /* Build the Yocto base system. */
    _buildBase: function(architecture, cancellable) {
        let basemeta = this._snapshot.getExpanded(this._snapshot.data['base']['name']);
	let basename = basemeta['name'];
	let buildWorkdir = this.subworkdir.get_child('build-' + basemeta['name'] + '-' + architecture);
        let checkoutdir = buildWorkdir.get_child(basemeta['name']);
        let builddirName = Format.vprintf('build-%s-%s', [basename, architecture]);
        let builddir = this.workdir.get_child(builddirName);
	let buildname = 'bases/' + basename + '-' + architecture;

        let forceRebuild = false; // (this.forceBuildComponents[basename] ||
                                  // basemeta['src'].indexOf('local:') == 0);

        let previousBuild = this._componentBuildCache[buildname];
	let previousVcsVersion = null;
	if (previousBuild != null) {
	    previousVcsVersion = previousBuild['revision'];
	}
	if (forceRebuild) {
	    print(Format.vprintf("%s forced rebuild", [builddirName]));
	} else if (previousVcsVersion == basemeta['revision']) {
	    print(Format.vprintf("Already built %s at %s", [builddirName, previousVcsVersion]));
	    return;
	} else if (previousVcsVersion != null) {
	    print(Format.vprintf("%s was %s, now at revision %s", [builddirName, previousVcsVersion, basemeta['revision']]));
	} 

	let ftype = checkoutdir.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, cancellable);
        if (ftype == Gio.FileType.SYMBOLIC_LINK)
	    GSystem.file_unlink(checkoutdir, cancellable);

	GSystem.file_ensure_directory(checkoutdir.get_parent(), true, cancellable);

        let [keytype, uri] = Vcs.parseSrcKey(basemeta['src']);
        if (keytype == 'local') {
	    GSystem.shutil_rm_rf(checkoutdir, cancellable);
	    checkoutdir.make_symbolic_link(uri, cancellable);
        } else {
            Vcs.getVcsCheckout(this.mirrordir, basemeta, checkoutdir, cancellable,
                               {overwrite:false});
	}

        // Just keep reusing the old working directory downloads and sstate
        let oldBuilddir = this.workdir.get_child('build-' + basemeta['name']);
        let sstateDir = oldBuilddir.get_child('sstate-cache');
        let downloads = oldBuilddir.get_child('downloads');

        let cmd = ['linux-user-chroot', '--unshare-pid', '/',
		   this.libdir.get_path() + '/ostree-build-yocto',
		   checkoutdir.get_path(), builddir.get_path(), architecture,
		   this.repo.get_path()];
        // We specifically want to kill off any environment variables jhbuild
        // may have set.
        let env = {};
	Lang.copyProperties(BuildUtil.BUILD_ENV, env);
        env['DL_DIR'] = downloads.get_path();
        env['SSTATE_DIR'] = sstateDir.get_path();
        ProcUtil.runSync(cmd, cancellable, {env:ProcUtil.objectToEnvironment(env)});

	let componentTypes = ['runtime', 'devel'];
        for (let i = 0; i < componentTypes.length; i++) {
	    let componentType = componentTypes[i];
	    let treename = Format.vprintf('%s/bases/%s/%s-%s', [this.osname, basename, architecture, componentType]);
	    let tarPath = builddir.get_child(Format.vprintf('gnomeos-contents-%s-%s.tar.gz', [componentType, architecture]));
	    ProcUtil.runSync(['ostree', '--repo=' + this.repo.get_path(),
			      'commit', '-s', 'Build', '--skip-if-unchanged',
			      '-b', treename, '--tree=tar=' + tarPath.get_path()],
			     cancellable,
			     {logInitiation: true});
	    GSystem.file_unlink(tarPath, cancellable);
	}

	GSystem.shutil_rm_rf(checkoutdir, cancellable);

	this._rebuiltComponents.push(basename);
	
	this._writeComponentCache(buildname, basemeta, cancellable);
    },

    _findTargetInList: function(name, targetList) {
	for (let i = 0; i < targetList.length; i++) {
	    if (targetList[i]['name'] == name)
		return targetList[i];
	}
	throw new Error("Failed to find target " + name);
    },

    execute: function(cancellable) {
	this.subworkdir = Gio.File.new_for_path('.');

        this.forceBuildComponents = {};
	for (let i = 0; i < this.parameters.forceComponents.length; i++)
	    this.forceBuildComponents[this.parameters.forceComponents[i]] = true;
        this.cachedPatchdirRevision = null;

	let snapshotDir = this.workdir.get_child('snapshots');
	let srcdb = new JsonDB.JsonDB(snapshotDir);
	let snapshotPath = srcdb.getLatestPath();
	let workingSnapshotPath = this.subworkdir.get_child(snapshotPath.get_basename());
	GSystem.file_linkcopy(snapshotPath, workingSnapshotPath, Gio.FileCopyFlags.OVERWRITE,
			      cancellable);
	let data = srcdb.loadFromPath(workingSnapshotPath, cancellable);
	this._snapshot = new Snapshot.Snapshot(data, workingSnapshotPath);
        let osname = this._snapshot.data['osname'];
	this.osname = osname;

	this._rebuiltComponents = [];

	this.patchdir = this.workdir.get_child('patches');

        let components = this._snapshot.data['components'];

	let builddb = this._getResultDb('build');

	let targetSourceVersion = builddb.parseVersionStr(this._snapshot.path.get_basename());

	// Pick up overrides from $workdir/overrides/$name
        for (let i = 0; i < components.length; i++) {
	    let component = components[i];
	    let name = component['name'];
	    let overridePath = this.workdir.resolve_relative_path('overrides/' + name);
	    if (overridePath.query_exists(null)) {
		print("Using override:  " + overridePath.get_path());
		component['src'] = 'local:' + overridePath.get_path();
		// We don't want to attempt to apply patches over top
		// of what the override has.
		delete component['patches'];
	    }
	}

	let haveLocalComponent = false;
        for (let i = 0; i < components.length; i++) {
	    let component = components[i];
	    if (component['src'].indexOf('local:') == 0)
		haveLocalComponent = true;
	}

	let latestBuildPath = builddb.getLatestPath();
	if (latestBuildPath != null) {
	    let lastBuiltSourceData = builddb.loadFromPath(latestBuildPath, cancellable);
	    let lastBuiltSourceVersion = builddb.parseVersionStr(lastBuiltSourceData['snapshotName']);
	    if (!haveLocalComponent && lastBuiltSourceVersion == targetSourceVersion) {
		print("Already built source snapshot " + lastBuiltSourceVersion);
		return;
	    } else {
		print("Last successful build was " + lastBuiltSourceVersion);
	    }
	}
	print("building " + targetSourceVersion);

	this.repo = this.workdir.get_child('repo');

        GSystem.file_ensure_directory(this.repo, true, cancellable);
        if (!this.repo.get_child('objects').query_exists(cancellable)) {
            ProcUtil.runSync(['ostree', '--repo=' + this.repo.get_path(), 'init', '--archive'],
			     cancellable);
	}

        this._componentBuildCachePath = this.cachedir.get_child('component-builds.json');
        if (this._componentBuildCachePath.query_exists(cancellable)) {
            this._componentBuildCache = JsonUtil.loadJson(this._componentBuildCachePath, cancellable);
        } else {
            this._componentBuildCache = {};
	}

        let baseName = this._snapshot.data['base']['name'];
        let architectures = this._snapshot.data['architectures'];

        for (let i = 0; i < architectures.length; i++) {
            this._buildBase(architectures[i], cancellable);
	}

        let componentToArches = {};

        let runtimeComponents = [];
        let develComponents = [];
        let testingComponents = [];

        for (let i = 0; i < components.length; i++) {
	    let component = components[i];
            let name = component['name']

            let isRuntime = (component['component'] || 'runtime') == 'runtime';
            let isTesting = (component['component'] || 'runtime') == 'testing';

            if (isRuntime) {
                runtimeComponents.push(component);
	    } else if (isTesting) {
		testingComponents.push(component);
	    }
	    develComponents.push(component);

	    let isNoarch = component['noarch'] || false;
	    let componentArches;
            if (isNoarch) {
                // Just use the first specified architecture
                componentArches = [architectures[0]];
            } else {
                componentArches = component['architectures'] || architectures;
	    }
            componentToArches[name] = componentArches;
	}

        let componentsToBuild = [];
        let componentSkippedCount = 0;
        let componentBuildRevs = {};

        for (let i = 0; i < components.length; i++) {
	    let component = components[i];
            for (let j = 0; j < architectures.length; j++) {
                componentsToBuild.push([component, architectures[j]]);
	    }
	}

	let previousBuildEpoch = this._componentBuildCache['build-epoch'];
	let currentBuildEpoch = this._snapshot.data['build-epoch'];
	if (previousBuildEpoch === undefined ||
	    (currentBuildEpoch !== undefined &&
	     previousBuildEpoch['version'] < currentBuildEpoch['version'])) {
	    let currentEpochVer = currentBuildEpoch['version'];
	    let rebuildAll = currentBuildEpoch['all'];
	    let rebuilds = [];
	    if (rebuildAll) {
		for (let i = 0; i < components.length; i++) {
		    rebuilds.push(components[i]['name']);
		}
	    } else {
		rebuilds = currentBuildEpoch['component-names'];
	    }
	    for (let i = 0; i < rebuilds.length; i++) {
		let component = this._snapshot.getComponent(rebuilds[i]);
		let name = component['name'];
		print("Component " + name + " build forced via epoch");
		for (let j = 0; j < architectures.length; j++) {
		    let buildRef = this._componentBuildRef(component, architectures[j]);
		    delete this._componentBuildCache[buildRef];
		}
	    }
	}

	this._componentBuildCache['build-epoch'] = currentBuildEpoch;
        JsonUtil.writeJsonFileAtomic(this._componentBuildCachePath, this._componentBuildCache, cancellable);

        for (let i = 0; i < componentsToBuild.length; i++) {
	    let [component, architecture] = componentsToBuild[i];
            let archname = component['name'] + '/' + architecture;
            let buildRev = this._buildOneComponent(component, architecture, cancellable);
            componentBuildRevs[archname] = buildRev;
	}

        let targetsList = [];
	let componentTypes = ['runtime', 'runtime-debug', 'devel', 'devel-debug'];
        for (let i = 0; i < componentTypes.length; i++) {
	    let targetComponentType = componentTypes[i];
            for (let i = 0; i < architectures.length; i++) {
		let architecture = architectures[i];
                let target = {};
                targetsList.push(target);
                target['name'] = 'buildmaster/' + architecture + '-' + targetComponentType;

                let baseRuntimeRef = baseName + '/' + architecture + '-runtime';
                let buildrootRef = baseName + '/' + architecture + '-devel';
		let baseRef;
                if (targetComponentType == 'runtime') {
                    baseRef = baseRuntimeRef;
                } else {
                    baseRef = buildrootRef;
		}
                target['base'] = {'name': baseRef,
                                  'runtime': baseRuntimeRef,
                                  'devel': buildrootRef};

		let targetComponents;
                if (targetComponentType.indexOf('runtime-') == 0) {
                    targetComponents = runtimeComponents;
                } else {
                    targetComponents = develComponents;
		}
                    
                let contents = [];
                for (let i = 0; i < targetComponents.length; i++) {
		    let component = targetComponents[i];
                    if (component['bootstrap']) {
                        continue;
		    }
                    let buildsForComponent = componentToArches[component['name']];
                    if (buildsForComponent.indexOf(architecture) == -1) {
			continue;
		    }
                    let binaryName = component['name'] + '/' + architecture;
                    let componentRef = {'name': binaryName};
                    if (targetComponentType == 'runtime') {
                        componentRef['trees'] = ['/runtime'];
                    } else if (targetComponentType == 'runtime-debug') {
                        componentRef['trees'] = ['/runtime', '/debug'];
                    } else if (targetComponentType == 'devel') {
                        componentRef['trees'] = ['/runtime', '/devel', '/tests', '/doc']
		    } else if (targetComponentType == 'devel-debug') {
                        componentRef['trees'] = ['/runtime', '/devel', '/tests', '/doc', '/debug'];
		    }
                    contents.push(componentRef);
		}
                target['contents'] = contents;
	    }
	}

	this._installedTestsBuildrootRev = {};
	let targetRevisions = {};
	let finalInstalledTestRevisions = {};
	let buildData = { snapshotName: this._snapshot.path.get_basename(),
			  snapshot: this._snapshot.data,
			  targets: targetRevisions };
	buildData['installed-tests'] = finalInstalledTestRevisions;

	let composeTreeTaskCount = 0;
	let composeTreeTaskError = null;
	let composeTreeTaskLoop = GLib.MainLoop.new(null, true);

	// First loop over the -devel trees per architecture, and
	// generate an initramfs.
	let archInitramfsImages = {};
        for (let i = 0; i < architectures.length; i++) {
	    let architecture = architectures[i];
	    let develTargetName = 'buildmaster/' + architecture + '-devel';
	    let develTarget = this._findTargetInList(develTargetName, targetsList);

	    // Gather a list of components upon which the initramfs depends
	    let initramfsDepends = [];
	    for (let j = 0; j < components.length; j++) {
		let component = components[j];
		if (!component['initramfs-depends'])
		    continue;
		let archname = component['name'] + '/' + architecture;
		let buildRev = componentBuildRevs[archname];
		initramfsDepends.push(component['name'] + ':' + buildRev);
	    }

	    composeTreeTaskCount++;
	    this._checkoutOneTreeAsync(develTarget, componentBuildRevs, cancellable,
				       Lang.bind(this, function (result, err) {
					   if (err) {
					       if (composeTreeTaskError === null)
						   composeTreeTaskError = err;
					       composeTreeTaskLoop.quit();
					       return;
					   }
					   let [composeRootdir, relatedTmpPath] = result;
					   let kernelInitramfsData = this._prepareKernelAndInitramfs(architecture, composeRootdir, initramfsDepends, cancellable);
					   archInitramfsImages[architecture] = kernelInitramfsData;
					   this._installKernelAndInitramfs(kernelInitramfsData, composeRootdir, cancellable);
					   this._commitComposedTreeAsync(develTargetName, composeRootdir, relatedTmpPath, cancellable,
									 Lang.bind(this, function(result, err) {
									     if (err) {
										 if (composeTreeTaskError === null)
										     composeTreeTaskError = err;
										 composeTreeTaskLoop.quit();
										 return;
									     }
									     composeTreeTaskCount--;
									     let [treename, ostreeRev] = result;
									     targetRevisions[treename] = ostreeRev;
									     // Also note the revision of this, since it will be used
									     // as the buildroot for installed tests
									     this._installedTestsBuildrootRev[architecture] = ostreeRev;
									     if (composeTreeTaskCount == 0)
										 composeTreeTaskLoop.quit();
									 }));
				       }));
	}

	composeTreeTaskLoop.run();
	if (composeTreeTaskError)
	    throw new Error(composeTreeTaskError);

	// Now loop over the other targets per architecture, reusing
	// the initramfs cached from -devel generation.
	let nonDevelTargets = ['runtime', 'runtime-debug', 'devel-debug'];
	for (let i = 0; i < nonDevelTargets.length; i++) {
	    let target = nonDevelTargets[i];
            for (let j = 0; j < architectures.length; j++) {
		let architecture = architectures[j];
		let runtimeTargetName = 'buildmaster/' + architecture + '-' + target;
		let runtimeTarget = this._findTargetInList(runtimeTargetName, targetsList);

		composeTreeTaskCount++;
		this._checkoutOneTreeAsync(runtimeTarget, componentBuildRevs, cancellable,
					   Lang.bind(this, function(result, err) {
					       if (err) {
						   if (composeTreeTaskError === null)
						       composeTreeTaskError = err;
						   composeTreeTaskLoop.quit();
						   return;
					       }
					       composeTreeTaskCount--;
					       let [composeRootdir, relatedTmpPath] = result;
					       let kernelInitramfsData = archInitramfsImages[architecture];
					       this._installKernelAndInitramfs(kernelInitramfsData, composeRootdir, cancellable);
					       composeTreeTaskCount++;
					       this._commitComposedTreeAsync(runtimeTargetName, composeRootdir, relatedTmpPath, cancellable,
									     Lang.bind(this, function(result, err) {
										 if (err) {
										     if (composeTreeTaskError === null)
											 composeTreeTaskError = err;
										     composeTreeTaskLoop.quit();
										     return;
										 }
										 composeTreeTaskCount--;
										 let [treename, ostreeRev] = result;
										 targetRevisions[treename] = ostreeRev;
										 if (composeTreeTaskCount == 0)
										     composeTreeTaskLoop.quit();
									     }));
					   }));
	    }
	}

	composeTreeTaskLoop.run();
	if (composeTreeTaskError)
	    throw new Error(composeTreeTaskError);

	let installedTestComponentNames = this._snapshot.data['installed-tests-components'] || [];
	print("Using installed test components: " + installedTestComponentNames.join(', '));
	let installedTestContents = {};
        for (let i = 0; i < architectures.length; i++) {
	    installedTestContents[architectures[i]] = [];
	}
	for (let i = 0; i < testingComponents.length; i++) {
	    let component = testingComponents[i];
	    let name = component['name'];
            for (let j = 0; j < architectures.length; j++) {
		let architecture = architectures[j];
		let archname = component['name'] + '/' + architecture;
		let rev = componentBuildRevs[archname];
		if (!rev)
		    throw new Error("no build for " + buildRef);
		installedTestContents[architecture].push([rev, '/runtime']);
	    }
	}
	for (let i = 0; i < runtimeComponents.length; i++) {
	    let component = runtimeComponents[i];
	    for (let j = 0; j < architectures.length; j++) {
		let architecture = architectures[j];
		let archname = component['name'] + '/' + architecture;
		let rev = componentBuildRevs[archname];
		installedTestContents[architecture].push([rev, '/tests'])
	    }
	}
        for (let i = 0; i < installedTestComponentNames.length; i++) {
	    let componentName = installedTestComponentNames[i];
            for (let j = 0; j < architectures.length; j++) {
		let architecture = architectures[j];
		let archname = componentName + '-installed-tests' + '/' + architecture;
		let component = this._snapshot.getComponent(componentName);
		let buildRev = this._buildOneComponent(component, architecture, cancellable, { installedTests: true });
		installedTestContents[architecture].push([buildRev, '/runtime']);
		installedTestContents[architecture].push([buildRev, '/tests']);
	    }
	}
	for (let architecture in installedTestContents) {
	    let rootName = 'buildmaster/' + architecture + '-installed-tests';
	    let composeContents = [];
	    let contents = installedTestContents[architecture];
            for (let j = 0; j < contents.length; j++) {
		composeContents.push(contents[j]);
	    }
	    composeTreeTaskCount++;
	    this._checkoutOneTreeCoreAsync(rootName, composeContents, cancellable,
					   Lang.bind(this, function(result, err) {
					       if (err) {
						   if (composeTreeTaskError === null)
						       composeTreeTaskError = err;
						   composeTreeTaskLoop.quit();
						   return;
					       }
					       let composeRootdir = result;
					       this._commitComposedTreeAsync(rootName, composeRootdir, null, cancellable,
									     Lang.bind(this, function(result, err) {
										 if (err) {
										     if (composeTreeTaskError === null)
											 composeTreeTaskError = err;
										     composeTreeTaskLoop.quit();
										     return;
										 }
										 let [treename, rev] = result;
										 finalInstalledTestRevisions[treename] = rev;
										 composeTreeTaskCount--;
										 if (composeTreeTaskCount == 0)
										     composeTreeTaskLoop.quit();
									     }));
					   }),
					  { runTriggers: false });
	}

	composeTreeTaskLoop.run();
	if (composeTreeTaskError)
	    throw new Error(composeTreeTaskError);

	let statusTxtPath = Gio.File.new_for_path('status.txt');
	statusTxtPath.replace_contents('built: ' + this._rebuiltComponents.join(' ') + '\n', null, false,
				       Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);

	let [path, modified] = builddb.store(buildData, cancellable);
	print("Build complete: " + path.get_path());
    }
});
