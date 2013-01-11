# Copyright (C) 2011 Colin Walters <walters@verbum.org>
#
# This library is free software; you can redistribute it and/or
# modify it under the terms of the GNU Lesser General Public
# License as published by the Free Software Foundation; either
# version 2 of the License, or (at your option) any later version.
#
# This library is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# Lesser General Public License for more details.
#
# You should have received a copy of the GNU Lesser General Public
# License along with this library; if not, write to the
# Free Software Foundation, Inc., 59 Temple Place - Suite 330,
# Boston, MA 02111-1307, USA.

ACLOCAL_AMFLAGS = -I m4 ${ACLOCAL_FLAGS}
AM_CPPFLAGS = -DDATADIR='"$(datadir)"' -DLIBEXECDIR='"$(libexecdir)"'
AM_CFLAGS = $(WARN_CFLAGS)

NULL = 
BUILT_SOURCES =
MANPAGES =
CLEANFILES =
EXTRA_DIST =
bin_PROGRAMS =
sbin_PROGRAMS =
bin_SCRIPTS =
libexec_PROGRAMS =
noinst_LTLIBRARIES =
noinst_PROGRAMS =
privlibdir = $(pkglibdir)
privlib_LTLIBRARIES =
INSTALL_DATA_HOOKS =

libgsystem_srcpath := src/libgsystem
libgsystem_cflags = $(GIO_UNIX_CFLAGS) -I$(srcdir)/src/libgsystem
libgsystem_libs = $(GIO_UNIX_LIBS)
include src/libgsystem/Makefile-libgsystem.am
privlib_LTLIBRARIES += libgsystem.la

include Makefile-ostbuild.am
include Makefile-tests.am

include $(INTROSPECTION_MAKEFILE)
INTROSPECTION_GIRS = GSystem-1.0.gir

GSystem-1.0.gir: libgsystem.la Makefile
GSystem_1_0_gir_NAMESPACE = GSystem
GSystem_1_0_gir_VERSION = 1.0
GSystem_1_0_gir_LIBS = libgsystem.la
GSystem_1_0_gir_CFLAGS = $(libgsystem_cflags)
GSystem_1_0_gir_SCANNERFLAGS =			\
       --warn-all				\
       --warn-error				\
       --symbol-prefix=gs_			\
       --identifier-prefix=GS			\
        --c-include="libgsystem.h"	        \
       $(NULL)
GSystem_1_0_gir_INCLUDES = Gio-2.0
GSystem_1_0_gir_FILES = $(libgsystem_la_SOURCES)

girdir= $(pkgdatadir)/gir-1.0
typelibdir= $(pkglibdir)/girepository-1.0

gir_DATA = $(INTROSPECTION_GIRS)
typelib_DATA = $(gir_DATA:.gir=.typelib)

install-data-hook: $(INSTALL_DATA_HOOKS)

release-tag:
	git tag -m "Release $(VERSION)" v$(VERSION)
