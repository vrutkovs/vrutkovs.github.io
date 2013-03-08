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

const Builtin = imports.builtin;
const Task = imports.task;
const JsonDB = imports.jsondb;
const FileUtil = imports.fileutil;
const ProcUtil = imports.procutil;
const StreamUtil = imports.streamutil;
const JsonUtil = imports.jsonutil;
const Snapshot = imports.snapshot;
const BuildUtil = imports.buildutil;
const Vcs = imports.vcs;
const ArgParse = imports.argparse;

const OPT_COMMON_CFLAGS = {'i686': '-O2 -g -m32 -march=i686 -mtune=atom -fasynchronous-unwind-tables',
                           'x86_64': '-O2 -g -m64 -mtune=generic'};

const DEVEL_DIRS = ['usr/include', 'usr/share/aclocal',
		    'usr/share/pkgconfig', 'usr/lib/pkgconfig'];
const DOC_DIRS = ['usr/share/doc', 'usr/share/gtk-doc',
		  'usr/share/man', 'usr/share/info'];

const TaskBuild = new Lang.Class({
    Name: "TaskBuild",
    Extends: Task.TaskDef,

    TaskName: "build",
    TaskAfter: ['resolve'],

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
    },

    _composeBuildroot: function(workdir, componentName, architecture, cancellable) {
        let starttime = GLib.DateTime.new_now_utc();

	let prefix = this._snapshot.data['prefix'];
        let buildname = Format.vprintf('%s/%s/%s', [prefix, componentName, architecture]);
        let buildrootCachedir = this.cachedir.resolve_relative_path('roots/' + buildname);
        GSystem.file_ensure_directory(buildrootCachedir, true, cancellable);

        let components = this._snapshot.data['components']
        let component = null;
        let buildDependencies = [];
        for (let i = 0; i < components.length; i++) {
	    let component = components[i];
            if (component['name'] == componentName)
                break;
            buildDependencies.push(component);
	}

        let refToRev = {};

        let archBuildrootName = Format.vprintf('bases/%s/%s-%s-devel', [this._snapshot.data['base']['name'],
									prefix,
									architecture]);

        print("Computing buildroot contents");

        let archBuildrootRev = ProcUtil.runSyncGetOutputUTF8Stripped(['ostree', '--repo=' + this.repo.get_path(), 'rev-parse',
								      archBuildrootName], cancellable);

        refToRev[archBuildrootName] = archBuildrootRev;
        let checkoutTrees = [[archBuildrootName, '/']];
        let refsToResolve = [];
        for (let i = 0; i < buildDependencies.length; i++) {
	    let dependency = buildDependencies[i];
            let buildname = Format.vprintf('components/%s/%s/%s', [prefix, dependency['name'], architecture]);
            refsToResolve.push(buildname);
            checkoutTrees.push([buildname, '/runtime']);
            checkoutTrees.push([buildname, '/devel']);
	}

        let resolvedRefs = this._resolveRefs(refsToResolve);
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
	for (let i = 0; i < checkoutTrees.length; i++) {
	    let [branch, subpath] = checkoutTrees[i];
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

        if (checkoutTrees.length > 0) {
            print(Format.vprintf("composing buildroot from %d parents (last: %s)", [checkoutTrees.length,
										    checkoutTrees[checkoutTrees.length-1][0]]));
	}

        let cachedRootTmp = cachedRoot.get_parent().get_child(cachedRoot.get_basename() + '.tmp');
	GSystem.shutil_rm_rf(cachedRootTmp, cancellable);
        ProcUtil.runSync(['ostree', '--repo=' + this.repo.get_path(),
			  'checkout', '--user-mode', '--union',
			  '--from-file=' + tmpPath.get_path(), cachedRootTmp.get_path()], cancellable);
        GSystem.file_unlink(tmpPath, cancellable);

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

    _saveComponentBuild: function(buildname, expandedComponent, cancellable) {
        let buildRef = 'components/' + buildname;
	let cachedata = {};
	Lang.copyProperties(expandedComponent, cachedata);
        cachedata['ostree'] = ProcUtil.runSyncGetOutputUTF8Stripped(['ostree', '--repo=' + this.repo.get_path(),
								     'rev-parse', buildRef], cancellable);
        this._componentBuildCache[buildname] = cachedata;
        JsonUtil.writeJsonFileAtomic(this._componentBuildCachePath, this._componentBuildCache, cancellable);
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
	
	if (srcInfo.get_file_type() != Gio.FileType.SYMBOLIC_LINK) {
	    let minimalMode = 436; // u+rw,g+rw,o+r
	    if (srcInfo.get_file_type() == Gio.FileType.DIRECTORY)
		minimalMode |= 64; // u+x
	    let mode = srcInfo.get_attribute_uint32('unix::mode');
	    GSystem.file_chmod(srcFile, mode | minimalMode, cancellable);
	}

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
    
    _processBuildResults: function(component, buildResultDir, finalResultDir, cancellable) {
	let runtimePath = finalResultDir.get_child('runtime');
	GSystem.file_ensure_directory(runtimePath, true, cancellable);
	let develPath = finalResultDir.get_child('devel');
	GSystem.file_ensure_directory(develPath, true, cancellable);
	let docPath = finalResultDir.get_child('doc');
	GSystem.file_ensure_directory(docPath, true, cancellable);

	// First, remove /var from the install - components are required to
	// auto-create these directories on demand.
	let varPath = buildResultDir.get_child('var');
	GSystem.shutil_rm_rf(varPath, cancellable);

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

	let libdir = buildResultDir.resolve_relative_path('usr/lib');

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

	this._installAndUnlink(buildResultDir, buildResultDir, runtimePath, cancellable);
    },

    _onBuildComplete: function(taskset, success, msg, loop) {
	this._currentBuildSucceded = success;
	this._currentBuildSuccessMsg = msg;
	loop.quit();
    },

    _buildOneComponent: function(component, architecture, cancellable) {
        let basename = component['name'];


	let prefix = this._snapshot.data['prefix'];
        let buildname = Format.vprintf('%s/%s/%s', [prefix, basename, architecture]);
        let unixBuildname = buildname.replace(/\//g, '_');
        let buildRef = 'components/' + buildname;

        let currentVcsVersion = component['revision'];
        let expandedComponent = this._snapshot.getExpanded(basename);
        let previousMetadata = this._componentBuildCache[buildname];
        let wasInBuildCache = (previousMetadata != null);
	let previousBuildVersion;
        if (wasInBuildCache) {
            previousBuildVersion = previousMetadata['ostree'];
        } else {
            previousBuildVersion = ProcUtil.runSyncGetOutputUTF8StrippedOrNull(['ostree', '--repo=' + this.repo.get_path(),
										'rev-parse', buildRef], cancellable);
	}
	let previousVcsVersion;
        if (previousMetadata != null) {
            previousVcsVersion = previousMetadata['revision'];
        } else if (previousBuildVersion != null) {
            let jsonstr = ProcUtil.runSyncGetOutputUTF8(['ostree', '--repo=' + this.repo.get_path(),
							 'cat', previousBuildVersion,
							 '/_ostbuild-meta.json'], cancellable);
	    previousMetadata = JSON.parse(jsonstr);
            previousVcsVersion = previousMetadata['revision'];
        } else {
            print("No previous build for " + buildname);
            previousVcsVersion = null;
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
                    print(Format.vprintf("Reusing cached build of %s at %s", [buildname, previousVcsVersion]));
                    if (!wasInBuildCache) {
                        return this._saveComponentBuild(buildname, expandedComponent, cancellable);
		    }
                    return previousBuildVersion;
                } else {
                    print("Build forced regardless");
		}
            } else {
                print(Format.vprintf("Need rebuild of %s: %s", [buildname, rebuildReason]));
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
        ProcUtil.runSync(childArgs, cancellable);

        GSystem.file_unlink(tempMetadataPath, cancellable);

        let componentResultdir = buildWorkdir.get_child('results');
        GSystem.file_ensure_directory(componentResultdir, true, cancellable);

        let rootdir = this._composeBuildroot(buildWorkdir, basename, architecture, cancellable);

        let tmpdir=buildWorkdir.get_child('tmp');
        GSystem.file_ensure_directory(tmpdir, true, cancellable);

        let srcCompileOnePath = this.libdir.get_child('ostree-build-compile-one');
        let destCompileOnePath = rootdir.get_child('ostree-build-compile-one');
	srcCompileOnePath.copy(destCompileOnePath, Gio.FileCopyFlags.OVERWRITE,
			       cancellable, null);
        GSystem.file_chmod(destCompileOnePath, 493, cancellable);
        
        let chrootSourcedir = Gio.File.new_for_path('/ostbuild/source/' + basename);

        childArgs = ['setarch', architecture];
        childArgs.push.apply(childArgs, BuildUtil.getBaseUserChrootArgs());
        childArgs.push.apply(childArgs, [
                '--mount-readonly', '/',
                '--mount-proc', '/proc', 
                '--mount-bind', '/dev', '/dev',
                '--mount-bind', tmpdir.get_path(), '/tmp',
                '--mount-bind', componentSrc.get_path(), chrootSourcedir.get_path(),
                '--mount-bind', componentResultdir.get_path(), '/ostbuild/results',
                '--chdir', chrootSourcedir.get_path(),
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
	proc.wait_sync_check(cancellable);

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

        let ostreeRevision = this._saveComponentBuild(buildname, expandedComponent, cancellable);

        return ostreeRevision;
    },

    _composeOneTarget: function(target, componentBuildRevs, cancellable) {
        let base = target['base'];
        let baseName = 'bases/' + base['name'];
        let runtimeName = 'bases/' + base['runtime'];
        let develName = 'bases/' + base['devel'];

        let composeRootdir = this.subworkdir.get_child(target['name']);
	GSystem.shutil_rm_rf(composeRootdir, cancellable);
        GSystem.file_ensure_directory(composeRootdir, true, cancellable);

        let relatedRefs = {};
        let baseRevision = ProcUtil.runSyncGetOutputUTF8Stripped(['ostree', '--repo=' + this.repo.get_path(),
								  'rev-parse', baseName], cancellable);

        let runtimeRevision = ProcUtil.runSyncGetOutputUTF8Stripped(['ostree', '--repo=' + this.repo.get_path(),
								     'rev-parse', runtimeName], cancellable);
        relatedRefs[runtimeName] = runtimeRevision;
        let develRevision = ProcUtil.runSyncGetOutputUTF8Stripped(['ostree', '--repo=' + this.repo.get_path(),
								   'rev-parse', develName], cancellable);
        relatedRefs[develName] = develRevision;

	let prefix = this._snapshot.data['prefix'];

	for (let name in componentBuildRevs) {
	    let rev = componentBuildRevs[name];
            let buildRef = 'components/' + prefix + '/' + name;
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

        ProcUtil.runSync(['ostree', '--repo=' + this.repo.get_path(),
			  'checkout', '--user-mode', '--no-triggers', '--union', 
			  '--from-file=' + contentsTmpPath.get_path(), composeRootdir.get_path()],
			 cancellable,
                         {logInitiation: true});
        GSystem.file_unlink(contentsTmpPath, cancellable);

        let contentsPath = composeRootdir.resolve_relative_path('usr/share/contents.json');
        JsonUtil.writeJsonFileAtomic(contentsPath, this._snapshot.data, cancellable);

        let treename = this.osname + '/' + target['name'];
        
        let ostreeRevision = ProcUtil.runSyncGetOutputUTF8Stripped(['ostree', '--repo=' + this.repo.get_path(),
								    'commit', '-b', treename, '-s', 'Compose',
								    '--owner-uid=0', '--owner-gid=0', '--no-xattrs', 
								    '--related-objects-file=' + relatedTmpPath.get_path(),
								    '--skip-if-unchanged'], cancellable,
								   {cwd: composeRootdir.get_path(),
								    logInitiation: true});
        GSystem.file_unlink(relatedTmpPath, cancellable);
        GSystem.shutil_rm_rf(composeRootdir, cancellable);
	return [treename, ostreeRevision];
    },

    /* Build the Yocto base system. */
    _buildBase: function(architecture, cancellable) {
        let basemeta = this._snapshot.getExpanded(this._snapshot.data['base']['name']);
	let basename = basemeta['name'];
	let buildWorkdir = this.subworkdir.get_child('build-' + basemeta['name'] + '-' + architecture);
        let checkoutdir = buildWorkdir.get_child(basemeta['name']);
        let builddirName = Format.vprintf('build-%s-%s', [basemeta['name'], architecture]);
        let builddir = this.workdir.get_child(builddirName);

        let forceRebuild = false; // (this.forceBuildComponents[basename] ||
                                  // basemeta['src'].indexOf('local:') == 0);

	let builtRevisionPath = builddir.get_child('built-revision');
	if (builtRevisionPath.query_exists(cancellable)) {
	    let builtRevision = GSystem.file_load_contents_utf8(builtRevisionPath, cancellable);
	    builtRevision = builtRevision.replace(/[ \n]/g, '');
	    if (forceRebuild) {
		print(Format.vprintf("%s forced rebuild", [builddirName]));
	    } else if (builtRevision == basemeta['revision']) {
		print(Format.vprintf("Already built %s at %s", [builddirName, builtRevision]));
		return;
	    } else {
		print(Format.vprintf("%s was %s, now at revision %s", [builddirName, builtRevision, basemeta['revision']]));
	    }
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
            Vcs.getVcsCheckout(this.mirrordir, keytype, uri, checkoutdir,
                               basemeta['revision'], cancellable,
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
	    let treename = Format.vprintf('bases/yocto/%s-%s-%s', [this.prefix, architecture, componentType]);
	    let tarPath = builddir.get_child(Format.vprintf('gnomeos-contents-%s-%s.tar.gz', [componentType, architecture]));
	    ProcUtil.runSync(['ostree', '--repo=' + this.repo.get_path(),
			      'commit', '-s', 'Build', '--skip-if-unchanged',
			      '-b', treename, '--tree=tar=' + tarPath.get_path()],
			     cancellable,
			     {logInitiation: true});
	    GSystem.file_unlink(tarPath, cancellable);
	}

	builtRevisionPath.replace_contents(basemeta['revision'], null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);
	GSystem.shutil_rm_rf(checkoutdir, cancellable);
    },

    execute: function(cancellable) {
	this.subworkdir = Gio.File.new_for_path('.');

        this.forceBuildComponents = {};
        this.cachedPatchdirRevision = null;

	let snapshotDir = this.workdir.get_child('snapshots');
	let srcdb = new JsonDB.JsonDB(snapshotDir);
	let snapshotPath = srcdb.getLatestPath();
	let workingSnapshotPath = this.subworkdir.get_child(snapshotPath.get_basename());
	GSystem.file_linkcopy(snapshotPath, workingSnapshotPath, Gio.FileCopyFlags.OVERWRITE,
			      cancellable);
	let data = srcdb.loadFromPath(workingSnapshotPath, cancellable);
	this._snapshot = new Snapshot.Snapshot(data, workingSnapshotPath);
        let prefix = this._snapshot.data['prefix'];
	this.prefix = prefix;
        let osname = this._snapshot.data['osname'];
	this.osname = osname;

	this.patchdir = this.workdir.get_child('patches');

        let components = this._snapshot.data['components'];

	let builddb = this._getResultDb('build');

	let targetSourceVersion = builddb.parseVersionStr(this._snapshot.path.get_basename());

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

        let basePrefix = this._snapshot.data['base']['name'] + '/' + prefix;
        let architectures = this._snapshot.data['architectures'];

        for (let i = 0; i < architectures.length; i++) {
            this._buildBase(architectures[i], cancellable);
	}

        let componentToArches = {};

        let runtimeComponents = [];
        let develComponents = [];

        for (let i = 0; i < components.length; i++) {
	    let component = components[i];
            let name = component['name']

            let isRuntime = (component['component'] || 'runtime') == 'runtime';

            if (isRuntime) {
                runtimeComponents.push(component);
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

        this._componentBuildCachePath = this.cachedir.get_child('component-builds.json');
        if (this._componentBuildCachePath.query_exists(cancellable)) {
            this._componentBuildCache = JsonUtil.loadJson(this._componentBuildCachePath, cancellable);
        } else {
            this._componentBuildCache = {};
	}

	let previousBuildEpoch = this._componentBuildCache['build-epoch'];
	let currentBuildEpoch = this._snapshot.data['build-epoch'];
	if (previousBuildEpoch === undefined ||
	    (currentBuildEpoch !== undefined &&
	     previousBuildEpoch['version'] < currentBuildEpoch['version'])) {
	    let currentEpochVer = currentBuildEpoch['version'];
	    let rebuilds = currentBuildEpoch['component-names'];
	    for (let i = 0; i < rebuilds.length; i++) {
		let component = this._snapshot.getComponent(rebuilds[i]);
		let name = component['name'];
		print("Component " + name + " build forced via epoch");
		this.forceBuildComponents[name] = true;
	    }
	}

	this._componentBuildCache['build-epoch'] = currentBuildEpoch;

        for (let i = 0; i < componentsToBuild.length; i++) {
	    let [component, architecture] = componentsToBuild[i];
            let archname = component['name'] + '/' + architecture;
            let buildRev = this._buildOneComponent(component, architecture, cancellable);
            componentBuildRevs[archname] = buildRev;
	}

        let targetsList = [];
	let componentTypes = ['runtime', 'devel'];
        for (let i = 0; i < componentTypes.length; i++) {
	    let targetComponentType = componentTypes[i];
            for (let i = 0; i < architectures.length; i++) {
		let architecture = architectures[i];
                let target = {};
                targetsList.push(target);
                target['name'] = 'buildmaster/' + architecture + '-' + targetComponentType;

                let runtimeRef = basePrefix + '-' + architecture + '-runtime';
                let buildrootRef = basePrefix + '-' + architecture + '-devel';
		let baseRef;
                if (targetComponentType == 'runtime') {
                    baseRef = runtimeRef;
                } else {
                    baseRef = buildrootRef;
		}
                target['base'] = {'name': baseRef,
                                  'runtime': runtimeRef,
                                  'devel': buildrootRef};

		let targetComponents;
                if (targetComponentType == 'runtime') {
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
                    } else {
                        componentRef['trees'] = ['/runtime', '/devel', '/doc']
		    }
                    contents.push(componentRef);
		}
                target['contents'] = contents;
	    }
	}

	let targetRevisions = {};
	let buildData = { snapshotName: this._snapshot.path.get_basename(),
			  snapshot: this._snapshot.data,
			  targets: targetRevisions };
        for (let i = 0; i < targetsList.length; i++) {
	    let target = targetsList[i];
            print(Format.vprintf("Composing %s from %d components", [target['name'], target['contents'].length]));
            let [treename, ostreeRev] = this._composeOneTarget(target, componentBuildRevs, cancellable);
	    targetRevisions[treename] = ostreeRev;
	}
	let [path, modified] = builddb.store(buildData, cancellable);
	print("Build complete: " + path.get_path());
    }
});
