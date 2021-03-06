var Property = require("./Property");
var Hook     = require("./Hook");
var enforce  = require("enforce");
var Q   	 = require("q");


exports.Instance = Instance;

function Instance(Model, opts) {
	opts = opts || {};
	opts.data = opts.data || {};
	opts.extra = opts.extra || {};
	opts.id = opts.id || "id";
	opts.changes = (opts.is_new ? Object.keys(opts.data) : []);
	opts.extrachanges = [];

	var instance_saving = false;
	var events = {};
	var instance = {};
	var emitEvent = function () {
		var args = Array.prototype.slice.apply(arguments);
		var event = args.shift();

		if (!events.hasOwnProperty(event)) return;

		events[event].map(function (cb) {
			cb.apply(instance, args);
		});
	};
	var handleValidations = function (cb) {
		var pending = [], errors = [], required;

		Hook.wait(instance, opts.hooks.beforeValidation, function (err) {
		    var k, i;
			if (err) {
				return saveError(cb, err);
			}

			for (i = 0; i < opts.one_associations.length; i++) {
				for (k in opts.one_associations[i].field) {
					if (opts.one_associations[i].required && opts.data[k] === null) {
					    var err = new Error("Property required");

						err.field = k;
						err.value = opts.data[k];
						err.msg   = "Property required";
						err.type  = "validation";
						err.model = Model.table;

						if (!Model.settings.get("instance.returnAllErrors")) {
							return cb(err);
						}

						errors.push(err);
					}
				}
			}

			var checks = new enforce.Enforce({
				returnAllErrors : Model.settings.get("instance.returnAllErrors")
			});

			for (k in opts.validations) {
				required = false;

				if (Model.properties[k]) {
					required = Model.properties[k].required;
				} else {
					for (i = 0; i < opts.one_associations.length; i++) {
						if (opts.one_associations[i].field === k) {
							required = opts.one_associations[i].required;
							break;
						}
					}
				}
				if (!required && instance[k] == null) {
					continue; // avoid validating if property is not required and is "empty"
				}
				for (i = 0; i < opts.validations[k].length; i++) {
					checks.add(k, opts.validations[k][i]);
				}
			}

			checks.context("instance", instance);
			checks.context("model", Model);
			checks.context("driver", opts.driver);

			return checks.check(instance, cb);
		});
	};
	var saveError = function (cb, err) {
		instance_saving = false;

		emitEvent("save", err, instance);

		Hook.trigger(instance, opts.hooks.afterSave, false);

		if (typeof cb === "function") {
			cb(err, instance);
		}
	};
	var saveInstance = function (cb, saveOptions) {
		// what this condition means:
		// - If the instance is in state mode
		// - AND it's not an association that is asking it to save
		//   -> return has already saved
		if (instance_saving && !(saveOptions.saveAssociations === false)) {
			return cb(null, instance);
		}
		instance_saving = true;

		handleValidations(function (err) {
			if (err) {
				return saveError(cb, err);
			}

			if (opts.is_new) {
				waitHooks([ "beforeCreate", "beforeSave" ], function (err) {
					if (err) {
						return saveError(cb, err);
					}

					return saveNew(cb, saveOptions, getInstanceData());
				});
			} else {
				waitHooks([ "beforeSave" ], function (err) {
					if (err) {
						return saveError(cb, err);
					}

					if (opts.changes.length === 0) {
					    if (saveOptions.saveAssociations === false) {
					        return saveInstanceExtra(cb);
					    }
					    return saveAssociations(function (err) {
					        return afterSave(cb, false, err);
					    });
					}

					return savePersisted(cb, saveOptions, getInstanceData());
				});
			}
		});
	};
	var afterSave = function (cb, create, err) {
		instance_saving = false;

		emitEvent("save", err, instance);

		if (create) {
			Hook.trigger(instance, opts.hooks.afterCreate, !err);
		}
		Hook.trigger(instance, opts.hooks.afterSave, !err);

		if (!err) {
			saveInstanceExtra(cb);
		}
	};
	var getInstanceData = function () {
		var data = {}, prop;
		for (var k in opts.data) {
			if (!opts.data.hasOwnProperty(k)) continue;
			prop = Model.allProperties[k];

			if (prop) {
				if (prop.type === 'serial' && opts.data[k] == null) continue;

				data[k] = Property.validate(opts.data[k], prop);
				if (opts.driver.propertyToValue) {
					data[k] = opts.driver.propertyToValue(data[k], prop);
				}
			} else {
				data[k] = opts.data[k];
			}
		}

		return data;
	};
	var waitHooks = function (hooks, next) {
		var nextHook = function () {
			if (hooks.length === 0) {
				return next();
			}
			Hook.wait(instance, opts.hooks[hooks.shift()], function (err) {
				if (err) {
					return next(err);
				}

				return nextHook();
			});
		};

		return nextHook();
	};
	var saveNew = function (cb, saveOptions, data) {
		var next = afterSave.bind(this, cb, true);

		opts.driver.insert(opts.table, data, opts.id, function (save_err, info) {
			if (save_err) {
				return saveError(cb, save_err);
			}

			opts.changes.length = 0;
			for (var i = 0; i < opts.id.length; i++) {
			    opts.data[opts.id[i]] = info.hasOwnProperty(opts.id[i]) ? info[opts.id[i]] : data[opts.id[i]];
			}
			opts.is_new = false;

			if (saveOptions.saveAssociations === false) {
				return next();
			}

			return saveAssociations(next);
		});
	};
	var savePersisted = function (cb, saveOptions, data) {
		var next = afterSave.bind(this, cb, false);
		var changes = {}, conditions = {};

		for (var i = 0; i < opts.changes.length; i++) {
			changes[opts.changes[i]] = data[opts.changes[i]];
		}
		for (i = 0; i < opts.id.length; i++) {
		    conditions[opts.id[i]] = data[opts.id[i]];
		}

		opts.driver.update(opts.table, changes, conditions, function (save_err) {
			if (save_err) {
				return saveError(cb, save_err);
			}

			opts.changes.length = 0;

			if (saveOptions.saveAssociations === false) {
				return next();
			}

			return saveAssociations(next);
		});
	};
	var saveAssociations = function (cb) {
		var pending = 1, errored = false, i, j;
		var saveAssociation = function (accessor, instances) {
			pending += 1;

			instance[accessor](instances, function (err) {
				if (err) {
					if (errored) return;

					errored = true;
					return cb(err);
				}

				if (--pending === 0) {
					return cb();
				}
			});
		};

		var _saveOneAssociation = function (assoc) {
		    if (!instance[assoc.name] || typeof instance[assoc.name] !== "object") return;
		    if (assoc.reversed) {
		        // reversed hasOne associations should behave like hasMany
		        if (!Array.isArray(instance[assoc.name])) {
		            instance[assoc.name] = [ instance[assoc.name] ];
		        }
		        for (var i = 0; i < instance[assoc.name].length; i++) {
		            if (!instance[assoc.name][i].isInstance) {
		                instance[assoc.name][i] = new assoc.model(instance[assoc.name][i]);
		            }
		            saveAssociation(assoc.setAccessor, instance[assoc.name][i]);
		        }
		        return;
		    }
		    if (!instance[assoc.name].isInstance) {
		        instance[assoc.name] = new assoc.model(instance[assoc.name]);
		    }

		    saveAssociation(assoc.setAccessor, instance[assoc.name]);
		};

		for (i = 0; i < opts.one_associations.length; i++) {
		    _saveOneAssociation(opts.one_associations[i]);
		}


		var _saveManyAssociation = function (assoc) {
		    if (!instance.hasOwnProperty(assoc.name)) return;
		    if (!Array.isArray(instance[assoc.name])) {
		        instance[assoc.name] = [ instance[assoc.name] ];
		    }

		    for (j = 0; j < instance[assoc.name].length; j++) {
		        if (!instance[assoc.name][j].isInstance) {
		            instance[assoc.name][j] = new assoc.model(instance[assoc.name][j]);
		        }
		    }

		    return saveAssociation(assoc.setAccessor, instance[assoc.name]);
		};

		for (i = 0; i < opts.many_associations.length; i++) {
			_saveManyAssociation(opts.many_associations[i]);
		}

		if (--pending === 0) {
			return cb();
		}
	};
	var saveInstanceExtra = function (cb) {
		if (opts.extrachanges.length === 0) {
			if (cb) return cb(null, instance);
			else return;
		}

		var data = {};
		var conditions = {};

		for (var i = 0; i < opts.extrachanges.length; i++) {
			if (!opts.data.hasOwnProperty(opts.extrachanges[i])) continue;

			if (opts.extra[opts.extrachanges[i]]) {
				data[opts.extrachanges[i]] = Property.validate(opts.data[opts.extrachanges[i]], opts.extra[opts.extrachanges[i]]);
				if (opts.driver.propertyToValue) {
					data[opts.extrachanges[i]] = opts.driver.propertyToValue(data[opts.extrachanges[i]], opts.extra[opts.extrachanges[i]]);
				}
			} else {
				data[opts.extrachanges[i]] = opts.data[opts.extrachanges[i]];
			}
		}

		for (i = 0; i < opts.extra_info.id.length; i++) {
		    conditions[opts.extra_info.id_prop[i]] = opts.extra_info.id[i];
		    conditions[opts.extra_info.assoc_prop[i]] = opts.data[opts.id[i]];
		}

		opts.driver.update(opts.extra_info.table, data, conditions, function (err) {
			if (cb)	return cb(err, instance);
		});
	};
	var removeInstance = function (cb) {
		if (opts.is_new) {
			return cb(null);
		}

		var conditions = {};
		for (var i = 0; i < opts.id.length; i++) {
		    conditions[opts.id[i]] = opts.data[opts.id[i]];
		}

		Hook.wait(instance, opts.hooks.beforeRemove, function (err) {
			if (err) {
				emitEvent("remove", err, instance);
				if (typeof cb === "function") {
					cb(err, instance);
				}
				return;
			}

			emitEvent("beforeRemove", instance);

			opts.driver.remove(opts.table, conditions, function (err, data) {
				Hook.trigger(instance, opts.hooks.afterRemove, !err);

				emitEvent("remove", err, instance);

				if (typeof cb === "function") {
					cb(err, instance);
				}

				instance = undefined;
			});
		});
	};
	var saveInstanceProperty = function (key, value) {
		var changes = {}, conditions = {};
		changes[key] = value;

		if (Model.properties[key]) {
			changes[key] = Property.validate(changes[key], Model.properties[key]);
			 if (opts.driver.propertyToValue) {
				changes[key] = opts.driver.propertyToValue(changes[key], Model.properties[key]);
			}
		}

		for (var i = 0; i < opts.id.length; i++) {
		    conditions[opts.id[i]] = opts.data[opts.id[i]];
		}

		Hook.wait(instance, opts.hooks.beforeSave, function (err) {
			if (err) {
				Hook.trigger(instance, opts.hooks.afterSave, false);
				emitEvent("save", err, instance);
				return;
			}

			opts.driver.update(opts.table, changes, conditions, function (err) {
				if (!err) {
					opts.data[key] = value;
				}
				Hook.trigger(instance, opts.hooks.afterSave, !err);
				emitEvent("save", err, instance);
			});
		});
	};
	var setInstanceProperty = function (key, value) {
		var prop = Model.allProperties[key] || opts.extra[key];

		if (prop) {
			if ('valueToProperty' in opts.driver) {
				value = opts.driver.valueToProperty(value, prop);
			}
			if (opts.data[key] !== value) {
				opts.data[key] = value;
				return true;
			}
		}
		return false;
	}

	var addInstanceProperty = function (key) {
		var defaultValue = null;
		var prop = Model.allProperties[key];

		// This code was first added, and then commented out in a later commit.
		// Its presence doesn't affect tests, so I'm just gonna log if it ever gets called.
		// If someone complains about noise, we know it does something, and figure it out then.
		if (instance.hasOwnProperty(key)) console.log("Overwriting instance property");

		if (key in opts.data) {
			defaultValue = opts.data[key];
		} else if (prop && 'defaultValue' in prop) {
			defaultValue = prop.defaultValue;
		}

		setInstanceProperty(key, defaultValue);

		Object.defineProperty(instance, key, {
			get: function () {
				return opts.data[key];
			},
			set: function (val) {
				if (Model.allProperties[key].key === true && opts.data[key] != null) {
					return;
				}

				if (!setInstanceProperty(key, val)) {
					return;
				}

				if (opts.autoSave) {
					saveInstanceProperty(key, val);
				} else if (opts.changes.indexOf(key) === -1) {
					opts.changes.push(key);
				}
			},
			enumerable: true
		});
	};
	var addInstanceExtraProperty = function (key) {
		if (!instance.hasOwnProperty("extra")) {
			instance.extra = {};
		}
		Object.defineProperty(instance.extra, key, {
			get: function () {
				return opts.data[key];
			},
			set: function (val) {
				setInstanceProperty(key, val);

				/*if (opts.autoSave) {
					saveInstanceProperty(key, val);
				}*/if (opts.extrachanges.indexOf(key) === -1) {
					opts.extrachanges.push(key);
				}
			},
			enumerable: true
		});
	};

	var i, k;

	for (k in Model.allProperties) {
		addInstanceProperty(k);
	}
	for (k in opts.extra) {
		addInstanceProperty(k);
	}

	for (k in opts.methods) {
		Object.defineProperty(instance, k, {
			value      : opts.methods[k].bind(instance),
			enumerable : false,
			writable  : true
		});
	}

	for (k in opts.extra) {
		addInstanceExtraProperty(k);
	}

	Object.defineProperty(instance, "on", {
		value: function (event, cb) {
			if (!events.hasOwnProperty(event)) {
				events[event] = [];
			}
			events[event].push(cb);

			return this;
		},
		enumerable: false,
		writable: true
	});
	Object.defineProperty(instance, "save", {
		value: function () {
			var arg = null, objCount = 0;
			var data = {}, saveOptions = {}, callback = null;

			while (arguments.length > 0) {
				arg = Array.prototype.shift.call(arguments);

				switch (typeof arg) {
					case 'object':
						switch (objCount) {
							case 0:
								data = arg;
								break;
							case 1:
								saveOptions = arg;
								break;
						}
						objCount++;
						break;
					case 'function':
						callback = arg;
						break;
					default:
					    var err = new Error("Unknown parameter type '" + (typeof arg) + "' in Instance.save()");
					    err.model = Model.table;
					    throw err;
				}
			}

			for (var k in data) {
				if (data.hasOwnProperty(k)) {
					this[k] = data[k];
				}
			}
			
			var defered=null;
			if (!callback) {
				var defered = Q.defer();
				callback = function(err,obj) {	
						if (err) {
							defered.reject(err);
						} else {
							defered.resolve(obj);	
						}
				}
			}

			saveInstance(callback, saveOptions);

			return defered ? defered.promise : this;
		},
		enumerable: false,
		writable: true
	});
	Object.defineProperty(instance, "saved", {
		value: function () {
			return opts.changes.length === 0;
		},
		enumerable: false,
		writable: true
	});
	Object.defineProperty(instance, "remove", {
		value: function (cb) {
			var defered=null;
			if (!cb) {
				var defered = Q.defer();
				cb = function(err,obj) {	
						if (err) {
							defered.reject(err);
						} else {
							defered.resolve(obj);	
						}
				}
			}

			removeInstance(cb);

			return defered ? defered.promise : this;
		},
		enumerable: false,
		writable: true
	});
	Object.defineProperty(instance, "isInstance", {
		value: true,
		enumerable: false
	});
	Object.defineProperty(instance, "isPersisted", {
		value: function () {
			return !opts.is_new;
		},
		enumerable: false,
		writable: true
	});
	Object.defineProperty(instance, "isShell", {
		value: function () {
			return opts.isShell;
		},
		enumerable: false
	});
	Object.defineProperty(instance, "validate", {
		value: function (cb) {
			handleValidations(function (errors) {
				cb(null, errors || false);
			});
		},
		enumerable: false,
		writable: true
	});
	Object.defineProperty(instance, "__singleton_uid", {
		value: function (cb) {
			return opts.uid;
		},
		enumerable: false
	});
	Object.defineProperty(instance, "model", {
		value: function (cb) {
			return Model;
		},
		enumerable: false
	});

	for (i = 0; i < opts.id.length; i++) {
	    if (!opts.data.hasOwnProperty(opts.id[i])) {
			opts.changes = Object.keys(opts.data);
			break;
		}
	}
	for (i = 0; i < opts.one_associations.length; i++) {
	    var asc = opts.one_associations[i];

		if (!asc.reversed && !asc.extension) {
		    for (k in opts.one_associations[i].field) {
		        if (!opts.data.hasOwnProperty(k)) {
		            addInstanceProperty(k);
		        }
		    }
		}

		if (opts.data.hasOwnProperty(asc.name)) {
			if (opts.data[asc.name] instanceof Object) {
				if (opts.data[asc.name].isInstance) {
					instance[asc.name] = opts.data[asc.name];
				} else {
				    var instanceInit = {};
				    var usedChance = false;
				    for (k in opts.one_associations[i].id) {
				        if (!data.hasOwnProperty(k) && !usedChance) {
				            instanceInit[k] = opts.data[asc.name];
				            usedChance = true;
				        } else {
				            instanceInit[k] = opts.data[k];
				        }
				    }

					instance[asc.name] = new opts.one_associations[i].model(instanceInit);
				}
			}
			delete opts.data[asc.name];
		}
	}
	for (i = 0; i < opts.many_associations.length; i++) {
		if (opts.data.hasOwnProperty(opts.many_associations[i].name)) {
			instance[opts.many_associations[i].name] = opts.data[opts.many_associations[i].name];
			delete opts.data[opts.many_associations[i].name];
		}
	}

	Hook.wait(instance, opts.hooks.afterLoad, function (err) {
		process.nextTick(function () {
			emitEvent("ready", err);
		});
	});

	return instance;
}
