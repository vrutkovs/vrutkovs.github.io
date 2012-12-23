Overview
--------

The build process is divided into two levels:

1. Yocto
2. ostbuild

Yocto is used as a reliable, well-maintained bootstrapping tool.  It
provides the basic filesystem layout as well as binaries for core
build utilities like gcc and bash.  This gets us out of circular
dependency problems.

At the end, the Yocto build process generates two tarballs: one for a
base "runtime", and one "devel" with all of the development tools like
gcc.  We then import that into an OSTree branch
e.g. "bases/yocto/gnomeos-3.6-i686-devel".

At present, it's still (mostly) possible to put this data on an ext4
filesystem and boot into it.

We also have a Yocto recipe "ostree-native" which generates (as you
might guess) a native binary of ostree.  That binary is used to import
into an "archive mode" OSTree repository.  You can see it in
$builddir/tmp/deploy/images/repo.

Now that we have an OSTree repository storing a base filesystem, we
can use "ostbuild" which uses "linux-user-chroot" to chroot inside,
run a build on a source tree, and outputs binaries, which we then add
to the build tree for the next module, and so on.

The final result of all of this is that the OSTree repository gains
new commits (which can be downloaded by clients), while still
retaining old build history.

Yocto details
-------------

I have a branch of Yocto here:

https://github.com/cgwalters/poky

It has a collection of patches on top of the "Edison" release of
Yocto, some of which are hacky, others upstreamable.  The most
important part though are the modifications to commit the generated
root filesystem into OSTree.

For every GNOME OS release, there is a branch on which the needed
patches have landed. By now, that branch is "gnomeos-3.6".

ostbuild details
----------------

The simple goal of ostbuild is that it only takes as input a
"manifest" which is basically just a list of components to build.  You
can see an example of this here:

http://git.gnome.org/gnome-ostree/gnomeos-3.6.json

A component is a pure metadata file which includes the git repository
URL and branch name, as well as ./configure flags (--enable-foo).

There is no support for building from "tarballs" - I want the ability
to review all of the code that goes in, and to efficiently store
source code updates.  It's also just significantly easier from an
implementation perspective, versus having to maintain a version
control abstraction layer.

The result of a build of a component is an OSTree branch like
"artifacts/gnomeos-3.6-i686-devel/libxslt/master".  Then, a "compose"
process merges together the individual filesystem trees into the final
branches (e.g. gnomeos-3.6-i686-devel).

Doing local builds
------------------

This is where you want to modify one (or a few) components on top of
what comes from the ostree.gnome.org server, and test the result
locally.  I'm working on this.

Doing a full build on your system
---------------------------------

The way I have things set up, I use jhbuild to build glib,
gobject-introspection, spidermonkey, gjs, and finally the gnome-ostree
build system.  See install/ostree.modules.

From there, just run:

$ ostbuild resolve --manifest=manifest.json --fetch
$ ostbuild build --prefix=gnomeos-3.8



