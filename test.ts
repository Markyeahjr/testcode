import { isFunction } from 'lodash';
import EventEmitter from 'eventemitter3';
import { MiddlewareFn, MiddlewareRunner } from '@base/ipc/core/utils';
import { Basic, MAIN_PROCESS_ID } from '@base/ipc/core/basic';
import { IpcClient } from '@base/ipc/core/clent';
import { IpcServer, IpcServerMiddlewareFn } from '@base/ipc/core/server';
import { IIpcProvider, MessageData, IpcMesageChannelOptions, EventNames, IBaseMessageChannel } from '@base/ipc/type';
import { TaskQueue } from '@lib/tools/queue';

export { MAIN_PROCESS_ID, Basic, IpcServerMiddlewareFn };
export const getSortName = (...args: any[]) => {
  return args.sort().join('-');
};

export class IpcBaseMessageChannel extends Basic {
  public messageCount: number = 0;
  public name: string;
  public targetId: number;
  public originId: number;
  public eventEmitter: EventEmitter = new EventEmitter();

  constructor(opt: IpcMesageChannelOptions) {
    super(opt.name);
    this.originId = opt.originId;
    this.targetId = opt.targetId;
    this.name = opt.name;
  }

  public isSelf() {
    return this.originId === this.targetId;
  }

  public onMessage(fn: any) {
    this.eventEmitter.on(EventNames.Message, fn);
  }

  public offMessage(fn?: any) {
    this.eventEmitter.off(EventNames.Message, fn);
  }
}

type RequestMiddlewareFn = MiddlewareFn<any[]>;
type ResponseMiddlewareFn = MiddlewareFn<MessageData>;
type ResponseMiddlewareRunner = MiddlewareRunner<MessageData>;
type RequestMiddlewareRunner = MiddlewareRunner<any[]>;
interface PipeOptions {
  on: ResponseMiddlewareFn;
  send: RequestMiddlewareFn;
}

export class IpcBaseProvider extends Basic {
  public selfId: number;
  public eventEmitter: EventEmitter = new EventEmitter();
  public queue: TaskQueue = new TaskQueue();
  public channelMap: Map<string, IBaseMessageChannel>;
  public responseMiddlewareRunner: ResponseMiddlewareRunner;
  public requestMiddlewareRunner: RequestMiddlewareRunner;
  public initialized: boolean = false;

  public constructor(name: string) {
    super(name);
    this.name = name;
    this.channelMap = new Map();
    this.queue.setExecuteFunction((task) => {
      return this.send(task.target, task.channelName, ...task.args);
    });
    this.responseMiddlewareRunner = new MiddlewareRunner<MessageData>();
    this.requestMiddlewareRunner = new MiddlewareRunner<any[]>();
    this.setLogEnabled(true);
  }

  public setInitialized() {
    this.initialized = true;
    this.queue.flush();
  }

  public getChannelName(targetId: number) {
    return getSortName(targetId, this.selfId);
  }

  public setChannel(name: string, channel: IBaseMessageChannel) {
    channel.onMessage(this._handleOnMessage.bind(this));
    this.channelMap.set(name, channel);
  }

  public setSelfChannel(channel: IBaseMessageChannel) {
    const name = this.getChannelName(this.selfId);
    this.setChannel(name, channel);
  }

  public updateSelfId(id: number) {
    this.selfId = id;
  }

  private _handleOnMessage(messageData: MessageData) {
    const { senderId, channel, data, receiverId } = messageData;
    // 过滤器
    // const res = await this.responseMiddlewareRunner.run(messageData);
    this.log(`handleOnMessage: channel: ${channel} from: ${senderId} data:`, data);
    // this.log('emit: ', this.getEventName(senderId, channel));
    const eventName = this.getEventName(senderId, channel);
    this.eventEmitter.emit(eventName, ...data, {
      senderId,
      receiverId,
    });
    // this.log('emit: ', this.getEventName('all', channel));
    const allEventName = this.getEventName('all', channel);
    this.eventEmitter.emit(allEventName, ...data, {
      senderId,
      receiverId,
    });
  }

  public getEventName(...names: any[]): string {
    return names.join('_');
  }

  public hasChannel(targetId: number): boolean {
    return this.channelMap.has(this.getChannelName(targetId));
  }

  public pushTask(target: number, channelName: string, ...args: any[]) {
    this.queue.push({
      target,
      channelName,
      args,
    });
  }

  public async send(target: number, channelName: string, ...args: any[]) {
    this.log('send:', target, channelName, ...args);
    if (!this.initialized) {
      this.pushTask(target, channelName, ...args);
      return;
    }
    const messageChannelName = this.getChannelName(target);
    const messageChannel = this.channelMap.get(messageChannelName);
    this.log('messageChannelName:', messageChannelName);
    if (messageChannel) {
      const res = await this.requestMiddlewareRunner.run(args);
      messageChannel.send(channelName, res);
    } else {
      throw new Error(`channel "${messageChannelName}" is not found`);
    }
  }

  public on(target: number | 'all', channelName: string, handler: (...args: any[]) => void) {
    const eventName = this.getEventName(target, channelName);
    this.log(`on: ${eventName}`);
    this.eventEmitter.on(eventName, handler);
  }

  public once(target: number | 'all', channelName: string, handler: (...args: any[]) => void) {
    this.eventEmitter.once(this.getEventName(target, channelName), handler);
  }

  public off(target: number | 'all', channelName: string, handler?: (...args: any[]) => void) {
    this.eventEmitter.off(this.getEventName(target, channelName), handler);
  }

  public pipe(opt: PipeOptions) {
    if (isFunction(opt.send)) {
      this.requestMiddlewareRunner.use(opt.send);
    } else if (isFunction(opt.on)) {
      this.responseMiddlewareRunner.use(opt.on);
    }
  }
}

export class IpcPlus extends Basic {
  private _ipc: IIpcProvider;
  public ipcClient: IpcClient;
  public ipcServer: IpcServer;
  public initialized = false;

  public constructor() {
    super('IpcProvider');
  }

  private _createIpcUrl(opt: { host: string; pathname: string; protocol: string }): string {
    return `${opt.protocol}//${opt.host}/${opt.pathname}`;
  }

  public init(ipcProvider: IIpcProvider) {
    if (this.initialized) {
      return;
    }
    this._ipc = ipcProvider;
    this.ipcClient = new IpcClient(ipcProvider);
    this.ipcServer = new IpcServer(ipcProvider);
    this.initialized = true;
  }

  public send(target: number | 'all', channel: string, ...args: any[]): void {
    this._ipc.send(target, channel, ...args);
  }

  public on(target: number | 'all', channel: string, handler: (...args: any[]) => void): void {
    this._ipc.on(target, channel, handler);
  }

  public off(target: number | 'all', channel: string, handler?: (...args: any[]) => void): void {
    this._ipc.off(target, channel, handler);
  }
  public once(target: number | 'all', channel: string, handler: (...args: any[]) => void): void {
    this._ipc.once(target, channel, handler);
  }

  public getChannelMap() {
    return this._ipc.channelMap;
  }

  public invoke(target: number | 'all', channel: string, data: any): Promise<any> {
    const url = this._createIpcUrl({
      protocol: 'ipc:',
      host: `${target}`,
      pathname: channel,
    });
    return this.ipcClient.send(url, {
      body: data,
    });
  }

  public handle(channel: string, handler: IpcServerMiddlewareFn): void {
    this.ipcServer.use(channel, handler);
  }
}
