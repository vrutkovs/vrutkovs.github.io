(function(exports) {
    'use strict';

    var bgo = angular.module('build.gnome.org', [
        'ngRoute',
        'bgoControllers',
    ]);

    bgo.config(['$routeProvider', function($routeProvider) {
        $routeProvider.
            when('/', {
                templateUrl: 'partials/home.html'
            }).
            when('/jhbuild-ubuntu-raring', {
                templateUrl: 'partials/jhbuild-ubuntu-raring.html'
            }).
            when('/gnome-continuous', {
                templateUrl: 'partials/gnome-continuous.html',
                controller: 'ContinuousHomeCtrl',
            }).
            when('/gnome-continuous/build/:buildVersion', {
                templateUrl: 'partials/gnome-continuous-build.html',
                controller: 'ContinuousBuildViewCtrl',
            }).
            when('/gnome-continuous/log/:year/:month/:day', {
                templateUrl: 'partials/gnome-continuous-log.html',
                controller: 'ContinuousLogCtrl',
            }).
            otherwise({
                redirectTo: '/',
            });
    }]);

})(window);
