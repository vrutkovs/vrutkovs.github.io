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
            });
        });
        $scope.tasks = tasks;

        var apps = [];
        $http.get(buildRoot + 'applicationstest/apps.json').success(function(data) {
            var apps = data['apps'];

            // Older builds use a different scheme for the
            // applicationstest; just ignore them.
            if (!apps.forEach)
                return;

            apps.forEach(function(app) {
                // Mangle the data a bit

                app.name = app.id; /* XXX */
                app.status = (app.state == "success") ? 'good' : 'bad';

                // XXX -- this should probably be in the template
                if (app.icon)
                    app.icon = ROOT + app.icon;
                else
                    app.icon = '/images/app-generic.png';

                app.screenshot = ROOT + app.screenshot;
            });
            $scope.apps = apps;
        });
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
