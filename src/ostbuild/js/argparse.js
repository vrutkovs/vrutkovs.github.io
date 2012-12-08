const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;

const ArgumentParser = new Lang.Class({
    Name: 'ArgumentParser',

    _init: function(description) {
	this.description = description;
	this._opts = [];
	this._namedArgs = [];
	this._optNames = {};
	this._argNames = {};
    },

    usage: function() {
	let buf = 'Usage: ' + this.description + '\n';
	for (let i = 0; i < this._opts.length; i++) {
	    let opt = this._opts[i];
	    let names = opt._names;
	    for (let j = 0; j < names.length; j++) {
		let name = names[j];
		buf += name;
		if (j < names.length - 1)
		    buf += ", ";
	    }
	    if (opt.description)
		buf += '        ' + opt.description;
	    buf += '\n';
	}
	for (let i = 0; i < this._namedArgs.length; i++) {
	    let arg = this._namedArgs[i];
	    buf += arg._varName + "\n";
	}
	return buf;
    },

    addArgument: function(nameOrNames, opts) {
	if (!opts)
	    opts = {};
	let names;
	if (nameOrNames instanceof Array)
	    names = nameOrNames;
	else
	    names = [nameOrNames];

	if (opts.action == undefined)
	    opts.action = 'store';

	if (names.length == 0) {
	    throw new Error("Must specify at least one argument");
	} else if (names.length == 1 && names[0][0] != '-') {
	    let name = names[0];
	    this._namedArgs.push(opts);
	    this._argNames[name] = opts;
	    opts._varName = name;
	} else {
	    opts._names = names;
	    this._opts.push(opts);

	    opts._varName = null;

	    let shortOpt = null;
	    
	    for (let i = 0; i < names.length; i++) {
		let name = names[i];
		if (this._optNames[name]) {
		    throw new Error("Argument " + name + " already added");
		} else if (names.length != 1 && name[0] != '-') {
		    throw new Error("Argument " + name + " does not start with -");
		}
		
		this._optNames[name] = opts;
		if (opts._varName == null) {
		    if (name.indexOf('--') == 0)
			opts._varName = name.substr(2);
		    else if (shortOpt == null && name[0] == '-' && name[1] != '-')
			shortOpt = name.substr(1);
		}
	    }
	    if (opts._varName == null)
		opts._varName = shortOpt;
	}
    },

    _failed: function() {
	print(this.usage());
	throw new Error("Argument parsing failed");
    },

    parse: function(argv) {
	let result = {};
	let rest = [];

	for (let name in this._optNames) {
	    let opts = this._optNames[name];
	    if (opts.action == 'store') {
		result[opts._varName] = null;
	    } else if (opts.action == 'storeTrue') {
		result[opts._varName] = false;
	    }
	}
	for (let name in this._argNames) {
	    result[name] = null;
	}

	let rest = [];
	
	for (let i = 0; i < argv.length; i++) {
	    let arg = argv[i];
	    if (arg[0] == '-') {
		let equalsIdx = arg.indexOf('=');
		let opts;
		if (equalsIdx != -1)
		    opts = this._optNames[arg.substr(0, equalsIdx)];
		else
		    opts = this._optNames[arg];
		
		if (!opts) this._failed();

		if (opts.action == 'store') {
		    if (i == argv.length - 1) this._failed();
		    result[opts._varName] = argv[i+1];
		    i++;
		} else if (opts.action == 'storeTrue') {
		    result[opts._varName] = true;
		    i++;
		}
	    } else {
		rest.push(arg);
	    }
	}
	
	for (let i = 0; i < this._namedArgs.length; i++) {
	    let a = this._namedArgs[i];
	    if (rest.length == 0) this._failed();
	    let value = rest.shift();
	    result[a._varName] = value;
	}

	return result;
    }
});
