/* @flow */
import type IConfig from "../interfaces/config";
import type ITask from "../interfaces/task";
import type IJob from "../interfaces/job";
import Container from "./container";
import StorageCapsule from "./storage-capsule";
import Config from "./config";
import Event from "./event";

import {
  log,
  clone,
  hasMethod,
  isFunction,
  excludeSpecificTasks,
  utilClearByTag
} from "./utils";
import LocalStorage from "./storage/localstorage";

interface IJobInstance {
  priority: number;
  retry: number;
  handle(args: any): any;
  before(args: any): void;
  after(args: any): void;
}

let Queue = (() => {
  "use strict";

  Queue.FIFO = "fifo";
  Queue.LIFO = "lifo";

  function Queue(config: IConfig) {
    _constructor.call(this, config);
  }

  function _constructor(config) {
    this.currentChannel;
    this.currentTimeout;
    this.stopped = true;
    this.running = false;
    this.channels = {};
    this.config = new Config(config);
    this.storage = new StorageCapsule(
      this.config,
      new LocalStorage(this.config)
    );
    this.event = new Event();
    this.container = new Container();
    this.timeout = this.config.get("timeout");
  }

  Queue.prototype.add = function(task): string | boolean {
    if (!canMultiple.call(this, task)) return false;

    const id = saveTask.call(this, task);

    if (id && this.stopped && this.running === true) {
      this.start();
    }

    // pass activity to the log service.
    logProxy.call(this, 'queue.created', task.handler);

    return id;
  };

  Queue.prototype.next = function() {
    if (this.stopped) {
      statusOff.call(this);
      return stopQueue.call(this);
    }

    logProxy.call(this, 'queue.next', 'next');

    this.start();
  };

  Queue.prototype.start = function(): boolean {
    // Stop the queue for restart
    this.stopped = false;

    // Register tasks, if not registered
    registerJobs.call(this);

    // Create a timeout for start queue
    this.running = createTimeout.call(this) > 0;

    logProxy.call(this, 'queue.starting', 'start');

    return this.running;
  };

  Queue.prototype.stop = function() {
    logProxy.call(this, 'queue.stopping', 'stop');
    this.stopped = true;
  };

  Queue.prototype.forceStop = function() {
    stopQueue.call(this);
  };

  Queue.prototype.create = function(channel: string) {
    if (!(channel in this.channels)) {
      this.currentChannel = channel;
      this.channels[channel] = clone(this);
    }

    return this.channels[channel];
  };

  Queue.prototype.channel = function(name: string) {
    if (!this.channels[name]) {
      throw new Error(`Channel of "${name}" not found`);
    }

    return this.channels[name];
  };

  Queue.prototype.isEmpty = function(): boolean {
    return this.count() < 1;
  };

  Queue.prototype.count = function(): Array<ITask> {
    return getTasksWithoutFreezed.call(this).length;
  };

  Queue.prototype.countByTag = function(tag: string): Array<ITask> {
    return getTasksWithoutFreezed.call(this).filter(t => t.tag === tag).length;
  };

  Queue.prototype.clear = function(): boolean {
    if (! this.currentChannel) return false;
    this.storage.clear(this.currentChannel);
    return true;
  };

  Queue.prototype.clearByTag = function(tag: string): void {
    db
      .call(this)
      .all()
      .filter(utilClearByTag.bind(tag))
      .forEach(t => db.call(this).delete(t._id));
  };

  Queue.prototype.has = function(id: string): boolean {
    return getTasksWithoutFreezed.call(this).findIndex(t => t._id === id) > -1;
  };

  Queue.prototype.hasByTag = function(tag: string): boolean {
    return getTasksWithoutFreezed.call(this).findIndex(t => t.tag === tag) > -1;
  };

  Queue.prototype.setTimeout = function(val: number): void {
    this.timeout = val;
    this.config.set("timeout", val);
  };

  Queue.prototype.setLimit = function(val: number): void {
    this.config.set("limit", val);
  };

  Queue.prototype.setPrefix = function(val: string): void {
    this.config.set("prefix", val);
  };

  Queue.prototype.setPrinciple = function(val: string): void {
    this.config.set("principle", val);
  };

  Queue.prototype.setDebug = function(val: boolean): void {
    this.config.set("debug", val);
  };

  Queue.prototype.on = function(key: string, cb: Function): void {
    this.event.on(...arguments);
    logProxy.call(this, 'event.created', key);
  };

  Queue.register = function(jobs: Array<IJob>) {
    if (!(jobs instanceof Array)) {
      throw new Error("Queue jobs should be objects within an array");
    }

    Queue.isRegistered = false;
    Queue.jobs = jobs;
  };

  function logProxy(key, data, cond) {
    log.call(
      // debug mode status
      this.config.get('debug'),

      // log arguments
      ...arguments
    );
  }

  function getTasksWithoutFreezed() {
    return db
      .call(this)
      .all()
      .filter(excludeSpecificTasks.bind(["freezed"]));
  }

  function dispatchEvents(task: ITask, type: string) {
    if ("tag" in task) {
      const events = [
        [`${task.tag}:${type}`, 'fired'],
        [`${task.tag}:*`, 'wildcard-fired']
      ];

      for (const event of events) {
        this.event.emit(event[0], task);
        logProxy.call(this, `event.${event[1]}`, event[0]);
      }
    }
  }

  function db() {
    return this.storage.channel(this.currentChannel);
  }

  function saveTask(task: ITask) {
    return db.call(this).save(task);
  }

  function saveTask(task: ITask) {
    return db.call(this).save(checkPriority(task));
  }

  function checkPriority(task: ITask) {
    task.priority = task.priority || 0;

    if (isNaN(task.priority)) task.priority = 0;

    return task;
  }

  function createTimeout(): number {
    // if running any job, stop it
    // the purpose here is to prevent cocurrent operation in same channel
    clearTimeout(this.currentTimeout);

    // get always last updated config value
    const timeout = this.config.get("timeout");

    // create new timeout for process a job in queue
    // binding loopHandler function to setTimeout
    // then return the timeout instance
    return (this.currentTimeout = setTimeout(loopHandler.bind(this), timeout));
  }

  function lockTask(task): boolean {
    return db.call(this).update(task._id, { locked: true });
  }

  function removeTask(id: string): boolean {
    return db.call(this).delete(id);
  }

  function loopHandler(): void {
    const self: Queue = this;
    const task: ITask = db
      .call(self)
      .fetch()
      .shift();

    if (task === undefined) {
      stopQueue.call(this);
      logProxy.call(this, 'queue.empty', this.currentChannel);
      return;
    }

    if (!self.container.has(task.handler)) {
      logProxy.call(this, 'queue.not-found', task.handler);
      failedJobHandler.call(this, task).call();
      return;
    }

    const job: IJob = self.container.get(task.handler);
    const jobInstance: IJobInstance = new job.handler();

    // lock the current task for prevent race condition
    lockTask.call(self, task);

    // fire job before event
    fireJobInlineEvent.call(this, "before", jobInstance, task.args);

    // dispacth custom before event
    dispatchEvents.call(this, task, "before");

    // preparing worker dependencies
    const dependencies = Object.values(job.deps || {});

    // Task runner promise
    jobInstance.handle
      .call(jobInstance, task.args, ...dependencies)
      .then(successJobHandler.call(self, task, jobInstance).bind(self))
      .catch(failedJobHandler.call(self, task, jobInstance).bind(self));
  }

  function successJobHandler(task: ITask, job: IJobInstance): Function {
    const self: Queue = this;
    return function(result: boolean) {
      if (result) {
        successProcess.call(self, task, job);
      } else {
        retryProcess.call(self, task, job);
      }

      // fire job after event
      fireJobInlineEvent.call(this, "after", job, task.args);

      // dispacth custom after event
      dispatchEvents.call(this, task, "after");

      // try next queue job
      self.next();
    };
  }

  function failedJobHandler(task: ITask, job?: IJobInstance): Function {
    return (result: boolean) => {
      removeTask.call(this, task._id);

      this.event.emit("error", task);

      this.next();
    };
  }

  function fireJobInlineEvent(name: string, job: IJobInstance, args: any): void {
    if (!hasMethod(job, name)) return;

    if (name == "before" && isFunction(job.before)) {
      job.before.call(job, args);
    } else if (name == "after" && isFunction(job.after)) {
      job.after.call(job, args);
    }
  }

  function statusOff(): void {
    this.running = false;
  }

  function stopQueue(): void {
    this.stop();

    clearTimeout(this.currentTimeout);

    logProxy.call(this, 'queue.stopped', 'stop');
  }

  function successProcess(task: ITask, job: IJobInstance): void {
    removeTask.call(this, task._id);
  }

  function retryProcess(task: ITask, job: IJobInstance): boolean {
    // dispacth custom retry event
    dispatchEvents.call(this, task, "retry");

    // update retry value
    let updateTask: ITask = updateRetry.call(this, task, job);

    // delete lock property for next process
    updateTask.locked = false;

    return db.call(this).update(task._id, updateTask);
  }

  function canMultiple(task: ITask): boolean {
    if (typeof task !== "object" || task.unique !== true) return true;

    return this.hasByTag(task.tag) < 1;
  }

  function updateRetry(task: ITask, job: IJobInstance): ITask {
    if (!("retry" in job)) {
      job.retry = 1;
    }

    if (!("tried" in task)) {
      task.tried = 0;
      task.retry = job.retry;
    }

    ++task.tried;

    if (task.tried >= job.retry) {
      task.freezed = true;
    }

    return task;
  }

  function registerJobs(): void {
    if (Queue.isRegistered) return;

    const jobs = Queue.jobs || [];

    for (const job of jobs) {
      const funcStr = job.handler.toString();
      const [strFunction, name] = funcStr.match(/function\s([a-zA-Z_]+).*?/);
      if (name) this.container.bind(name, job);
    }

    Queue.isRegistered = true;
  }

  return Queue;
})();

export default Queue;
