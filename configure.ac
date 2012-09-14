AC_PREREQ([2.63])
AC_INIT([gnome-ostree], [2012.3], [walters@verbum.org], [gnome-ostree], [https://live.gnome.org/OSTree/GnomeOSTree])
AC_CONFIG_HEADER([config.h])
AC_CONFIG_MACRO_DIR([m4])
AC_CONFIG_AUX_DIR([build-aux])

OS_NAME="GNOME-OSTree"
OS_ID=$PACKAGE_TARNAME
OS_VERSION=3.6
OS_PRETTY_NAME="$OS_NAME ($OS_VERSION, OE-Core edison, $PACKAGE_VERSION)"

AC_SUBST([OS_NAME])
AC_SUBST([OS_ID])
AC_SUBST([OS_VERSION])
AC_SUBST([OS_PRETTY_NAME])

AM_INIT_AUTOMAKE([1.11 -Wno-portability foreign no-define tar-ustar no-dist-gzip dist-xz])
AM_MAINTAINER_MODE([enable])
AM_SILENT_RULES([yes])

AM_PATH_PYTHON([2.6])

AC_ARG_ENABLE(buildsystem,
	    AS_HELP_STRING([--disable-buildsystem], [Don't install buildsystem]),,
	    enable_buildsystem=yes)
AM_CONDITIONAL(BUILDSYSTEM, test x$enable_buildsystem != xno)

AC_ARG_ENABLE(system-integration,
	    AS_HELP_STRING([--enable-system-integration], [Install integration for target system]),,
	    enable_system_integration=no)
AM_CONDITIONAL(SYSTEM_INTEGRATION, test x$enable_system_integration != xno)

AC_CONFIG_FILES([
src/integration/os-release
Makefile
])
AC_OUTPUT

echo "
    GNOME-OSTree $VERSION
"
