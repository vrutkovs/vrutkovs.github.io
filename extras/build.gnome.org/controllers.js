(function(exports) {
    'use strict';

    var bgoControllers = angular.module('bgoControllers', []);

    var taskNames = ['build', 'smoketest', 'integrationtest', 'applicationstest'];

    var ROOT = '/continuous/buildmaster/';

    bgoControllers.controller('ContinuousStatusCtrl', function($scope, $http) {
        $http.get(ROOT + 'results/tasks/build/build/meta.json').success(function(data) {
            $scope.status = data.success ? 'good' : 'bad';
            $scope.buildName = data.buildName;
        });
    });

    bgoControllers.controller('ContinuousBuildViewCtrl', function($scope, $http, $routeParams) {
        var buildName = $routeParams.buildName;
        $scope.buildName = buildName;

        var buildRoot = ROOT + 'builds/' + buildName + '/';

        var tasks = [];
        taskNames.forEach(function(taskName) {
            $http.get(buildRoot + taskName + '/meta.json').success(function(data) {
                // Mangle the data a bit so we can render it better
                data['name'] = taskName;

                tasks.push(data);

                if (taskName == 'smoketest')
                    $scope.smoketestImage = getUrl(data['path'] + '/work-gnome-continuous-x86_64-runtime/screenshot-final.png');
            });
        });
        $scope.tasks = tasks;

        var apps = [];
        $http.get(buildRoot + 'applicationstest/apps.json').success(function(data) {
            var appsDict = data['apps'];
            Object.keys(appsDict).forEach(function(id) {
                var app = appsDict[id];
                var icon = app.icon ? (ROOT + app.icon) : '/images/app-generic.png';
                apps.push({ id: id,
                            name: id, /* XXX */
                            status: (app.state == "success") ? 'good' : 'bad',
                            icon: icon });
            });
        });
        $scope.apps = apps;

    });

    bgoControllers.controller('ContinuousHomeCtrl', function($scope, $http) {
        var builds = [];

        // Just get the most recent build for now. We need an
        // API to iterate over all the builds.
        $http.get(ROOT + 'results/tasks/build/build/meta.json').success(function(data) {
            builds.push(data);
        });
        $scope.builds = builds;

        $http.get(ROOT + 'autobuilder-status.json').success(function(status) {
            var text;
            if (status.running.length > 0)
                text = 'Running: ' + status.running.join(' ') + '; load=' + status.systemLoad[0];
            else
                text = 'Idle, awaiting commits';

            $scope.runningState = text;
        });
    });

})(window);
