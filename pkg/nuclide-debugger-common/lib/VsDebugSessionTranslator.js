/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

import type {
  AtomNotificationType,
  DebuggerConfigAction,
} from '../../nuclide-debugger-base/lib/types';
import type {
  VsAdapterType,
  VSAdapterExecutableInfo,
} from '../../nuclide-debugger-common/lib/types';
import type {
  Level as OutputLevelType,
  Message,
} from '../../nuclide-console/lib/types';
import type {ClientCallback} from '../../nuclide-debugger-common';
import type {NuclideUri} from 'nuclide-commons/nuclideUri';
// eslint-disable-next-line nuclide-internal/no-cross-atom-imports
import * as NuclideDebugProtocol from '../../nuclide-debugger-base/lib/protocol-types';

import {arrayFlatten} from 'nuclide-commons/collection';
import {FileCache} from '../../nuclide-debugger-common';
import invariant from 'assert';
import {pathToUri, uriToPath} from '../../nuclide-debugger-common/lib/helpers';
import nuclideUri from 'nuclide-commons/nuclideUri';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import VsDebugSession from './VsDebugSession';
import {VsAdapterTypes} from './constants';
import {Observable, Subject} from 'rxjs';

function translateStopReason(stopReason: string): string {
  return stopReason;
}

function nuclideDebuggerLocation(
  scriptId: string,
  lineNumber: number,
  columnNumber: number,
): NuclideDebugProtocol.Location {
  return {
    scriptId,
    lineNumber,
    columnNumber,
  };
}

function getFakeLoaderPauseEvent(): NuclideDebugProtocol.DebuggerEvent {
  return {
    method: 'Debugger.paused',
    params: {
      callFrames: [],
      reason: 'initial break',
      data: {},
    },
  };
}

function getEmptyResponse(id: number): NuclideDebugProtocol.DebuggerResponse {
  return {id, result: {}};
}

function getErrorResponse(
  id: number,
  message: string,
): NuclideDebugProtocol.DebuggerResponse {
  return {id, error: {message}};
}

type CommandHandler = (
  command: NuclideDebugProtocol.DebuggerCommand,
) => Promise<
  NuclideDebugProtocol.DebuggerResponse | NuclideDebugProtocol.DebuggerEvent,
>;

/**
 * Instead of having every async command handler try/catch its own logic
 * and send error response when failing, this utility would provide
 * the try/catch wrapper for command handlers.
 */
function catchCommandError(handler: CommandHandler): CommandHandler {
  return async (command: NuclideDebugProtocol.DebuggerCommand) => {
    try {
      return await handler(command);
    } catch (error) {
      return getErrorResponse(command.id, error.message);
    }
  };
}

const OUTPUT_CATEGORY_TO_LEVEL = Object.freeze({
  console: 'debug',
  info: 'info',
  log: 'log',
  warning: 'warning',
  error: 'error',
  debug: 'debug',
  stderr: 'error',
  stdout: 'log',
  success: 'success',
});

// VSP deoesn't provide process id.
const VSP_PROCESS_ID = -1;

type TranslatorBreakpoint = {
  breakpointId: NuclideDebugProtocol.BreakpointId,
  path: NuclideUri,
  lineNumber: number,
  condition: string,
  resolved: boolean,
};

type BreakpointDescriptor = {
  breakpointId?: NuclideDebugProtocol.BreakpointId,
  lineNumber: number,
  condition: string,
};

type ThreadState = 'running' | 'paused';

type ThreadInfo = {
  state: ThreadState,
  callFrames?: NuclideDebugProtocol.CallFrame[],
  stopReason?: string,
};

/**
 * This translator will be responsible of mapping Nuclide's debugger protocol
 * requests to VSCode debugger protocol requests and back from VSCode's response
 * to Nuclide's responses and events.
 */
export default class VsDebugSessionTranslator {
  _adapterType: VsAdapterType;
  _session: VsDebugSession;
  _logger: log4js$Logger;
  _clientCallback: ClientCallback;
  _files: FileCache;
  _disposables: UniversalDisposable;
  _commands: Subject<NuclideDebugProtocol.DebuggerCommand>;
  _handledCommands: Set<string>;
  _breakpointsById: Map<
    NuclideDebugProtocol.BreakpointId,
    TranslatorBreakpoint,
  >;
  _lastBreakpointId: number;
  _threadsById: Map<number, ThreadInfo>;
  _mainThreadId: ?number;
  _debuggerArgs: Object;
  _debugMode: DebuggerConfigAction;
  _exceptionFilters: Array<string>;

  // Session state.
  _pausedThreadId: ?number;

  constructor(
    adapterType: VsAdapterType,
    adapter: VSAdapterExecutableInfo,
    debugMode: DebuggerConfigAction,
    debuggerArgs: Object,
    clientCallback: ClientCallback,
    logger: log4js$Logger,
  ) {
    this._adapterType = adapterType;
    this._debugMode = debugMode;
    this._session = new VsDebugSession('id', logger, adapter);
    this._debuggerArgs = debuggerArgs;
    this._clientCallback = clientCallback;
    this._logger = logger;
    this._commands = new Subject();
    this._handledCommands = new Set();
    this._breakpointsById = new Map();
    this._threadsById = new Map();
    this._mainThreadId = null;
    this._lastBreakpointId = 0;
    this._exceptionFilters = [];
    this._files = new FileCache((method, params) =>
      this._sendMessageToClient(({method, params}: any)),
    );

    // Ignore the first fake pause request.
    this._disposables = new UniversalDisposable(
      this._session,
      this._handleCommands().subscribe(message =>
        this._sendMessageToClient(message),
      ),
      this._listenToSessionEvents(),
    );
  }

  _handleCommands(): Observable<
    NuclideDebugProtocol.DebuggerResponse | NuclideDebugProtocol.DebuggerEvent,
  > {
    const resumeCommands = this._commandsOfType('Debugger.resume');
    return Observable.merge(
      // Ack debugger enabled and send fake pause event
      // (indicating readiness to receive config requests).
      this._commandsOfType('Debugger.enable').flatMap(command =>
        Observable.of(getEmptyResponse(command.id), getFakeLoaderPauseEvent()),
      ),
      this._commandsOfType('Debugger.pause').flatMap(
        catchCommandError(async command => {
          const mainThreadId =
            this._mainThreadId || Array.from(this._threadsById.keys())[0] || -1;
          await this._session.pause({threadId: mainThreadId});
          return getEmptyResponse(command.id);
        }),
      ),
      // Skip the fake resume command.
      resumeCommands.skip(1).flatMap(
        catchCommandError(async command => {
          if (this._pausedThreadId == null) {
            return getErrorResponse(command.id, 'No paused thread to resume!');
          }
          await this._session.continue({threadId: this._pausedThreadId});
          return getEmptyResponse(command.id);
        }),
      ),
      // Step over
      this._commandsOfType('Debugger.stepOver').flatMap(
        catchCommandError(async command => {
          if (this._pausedThreadId == null) {
            return getErrorResponse(
              command.id,
              'No paused thread to step over!',
            );
          }
          await this._session.next({threadId: this._pausedThreadId});
          return getEmptyResponse(command.id);
        }),
      ),
      // Step into
      this._commandsOfType('Debugger.stepInto').flatMap(
        catchCommandError(async command => {
          if (this._pausedThreadId == null) {
            return getErrorResponse(
              command.id,
              'No paused thread to step into!',
            );
          }
          await this._session.stepIn({threadId: this._pausedThreadId});
          return getEmptyResponse(command.id);
        }),
      ),
      // Step out
      this._commandsOfType('Debugger.stepOut').flatMap(
        catchCommandError(async command => {
          if (this._pausedThreadId == null) {
            return getErrorResponse(
              command.id,
              'No paused thread to step out!',
            );
          }
          await this._session.stepOut({threadId: this._pausedThreadId});
          return getEmptyResponse(command.id);
        }),
      ),
      // Get script source
      this._commandsOfType('Debugger.getScriptSource').flatMap(
        catchCommandError(async command => {
          invariant(command.method === 'Debugger.getScriptSource');
          const result = {
            scriptSource: await this._files.getFileSource(
              command.params.scriptId,
            ),
          };
          return {id: command.id, result};
        }),
      ),
      this._commandsOfType('Debugger.setPauseOnExceptions').switchMap(
        catchCommandError(async command => {
          invariant(command.method === 'Debugger.setPauseOnExceptions');
          const {state} = command.params;
          switch (state) {
            case 'none':
              this._exceptionFilters = [];
              break;
            case 'uncaught':
            case 'all':
              this._exceptionFilters = [state];
              break;
          }
          await this._session.setExceptionBreakpoints({
            filters: this._exceptionFilters,
          });
          return getEmptyResponse(command.id);
        }),
      ),
      this._commandsOfType('Debugger.continueToLocation').switchMap(
        catchCommandError(async command => {
          invariant(command.method === 'Debugger.continueToLocation');
          const {location} = command.params;
          await this._continueToLocation(location);
          return getEmptyResponse(command.id);
        }),
      ),
      // Ack config commands
      Observable.merge(
        this._commandsOfType('Debugger.setDebuggerSettings'),
        this._commandsOfType('Runtime.enable'),
      ).map(command => getEmptyResponse(command.id)),
      // Get properties
      this._commandsOfType('Runtime.getProperties').flatMap(
        catchCommandError(async command => {
          invariant(command.method === 'Runtime.getProperties');
          const result = await this._getProperties(command.id, command.params);
          return ({id: command.id, result}: any);
        }),
      ),
      // Set breakpoints
      this._handleSetBreakpointsCommands(),
      // Ack first resume command (indicating the session is ready to start).
      resumeCommands.take(1).map(command => getEmptyResponse(command.id)),
      // Remove breakpoints
      this._commandsOfType('Debugger.removeBreakpoint').flatMap(
        catchCommandError(async command => {
          invariant(command.method === 'Debugger.removeBreakpoint');
          await this._removeBreakpoint(command.params.breakpointId);
          return getEmptyResponse(command.id);
        }),
      ),
      this._commandsOfType('Debugger.getThreadStack').map(command => {
        invariant(command.method === 'Debugger.getThreadStack');
        const {threadId} = command.params;
        const threadInfo = this._threadsById.get(threadId);
        const callFrames =
          threadInfo != null && threadInfo.state === 'paused'
            ? threadInfo.callFrames
            : null;
        return {
          id: command.id,
          result: {callFrames: callFrames || []},
        };
      }),
      this._commandsOfType('Debugger.evaluateOnCallFrame').flatMap(
        catchCommandError(async command => {
          invariant(command.method === 'Debugger.evaluateOnCallFrame');
          const {callFrameId, expression} = command.params;
          const result: NuclideDebugProtocol.EvaluateResponse = await this._evaluateOnCallFrame(
            expression,
            Number(callFrameId),
          );
          return {
            id: command.id,
            result,
          };
        }),
      ),
      this._commandsOfType('Runtime.evaluate').flatMap(
        catchCommandError(async command => {
          invariant(command.method === 'Runtime.evaluate');
          const {expression} = command.params;
          const result: NuclideDebugProtocol.EvaluateResponse = await this._evaluateOnCallFrame(
            expression,
          );
          return {
            id: command.id,
            result,
          };
        }),
      ),
      // Error for unhandled commands
      this._unhandledCommands().map(command =>
        getErrorResponse(command.id, 'Unknown command: ' + command.method),
      ),
    );
  }

  async _continueToLocation(
    location: NuclideDebugProtocol.Location,
  ): Promise<void> {
    const {columnNumber, lineNumber, scriptId} = location;
    const source = {
      path: nuclideUri.getPath(scriptId),
      name: nuclideUri.basename(scriptId),
    };
    await this._files.registerFile(pathToUri(scriptId));
    await this._session.nuclide_continueToLocation({
      column: columnNumber || 1,
      line: lineNumber + 1,
      source,
    });
  }

  _handleSetBreakpointsCommands(): Observable<
    NuclideDebugProtocol.DebuggerResponse,
  > {
    const setBreakpointsCommands = this._commandsOfType(
      'Debugger.setBreakpointByUrl',
    );

    let startedDebugging = false;

    return Observable.concat(
      setBreakpointsCommands
        .buffer(
          this._commandsOfType('Debugger.resume').first().switchMap(() => {
            if (this._session.isReadyForBreakpoints()) {
              // Session is initialized and ready for breakpoint requests.
              return Observable.of(null);
            } else {
              // Session initialization is pending launch.
              startedDebugging = true;
              return Observable.fromPromise(this._startDebugging())
                .ignoreElements()
                .concat(this._session.observeInitializeEvents());
            }
          }),
        )
        .first()
        .flatMap(async commands => {
          // Upon session start, send the cached breakpoints
          // and other configuration requests.
          try {
            const responses = await this._setBulkBreakpoints(commands);
            await this._configDone();

            if (!startedDebugging) {
              startedDebugging = true;
              await this._startDebugging();
            }
            return responses;
          } catch (error) {
            return commands.map(({id}) => getErrorResponse(id, error.message));
          }
        }),
      // Following breakpoint requests are handled by
      // immediatelly passing to the active debug session.
      setBreakpointsCommands.flatMap(async command => {
        try {
          return await this._setBulkBreakpoints([command]);
        } catch (error) {
          return [getErrorResponse(command.id, error.message)];
        }
      }),
    ).flatMap(responses => Observable.from(responses));
  }

  _startDebugging(): Promise<mixed> {
    if (this._debugMode === 'launch') {
      return this._session.launch(this._debuggerArgs);
    } else {
      return this._session.attach(this._debuggerArgs);
    }
  }

  async _setBulkBreakpoints(
    setBreakpointsCommands: Array<NuclideDebugProtocol.DebuggerCommand>,
  ): Promise<Array<NuclideDebugProtocol.DebuggerResponse>> {
    if (!this._session.isReadyForBreakpoints()) {
      throw new Error('VsDebugSession is not ready for breakpoints');
    }
    if (setBreakpointsCommands.length === 0) {
      return [];
    }
    // Group breakpoint commands by file path.
    const breakpointCommandsByUrl = new Map();
    for (const command of setBreakpointsCommands) {
      invariant(command.method === 'Debugger.setBreakpointByUrl');
      const url = decodeURIComponent(command.params.url);
      const existing = breakpointCommandsByUrl.get(url);
      if (existing == null) {
        breakpointCommandsByUrl.set(url, [command]);
      } else {
        existing.push(command);
      }
    }

    const responseGroups = await Promise.all(
      Array.from(
        breakpointCommandsByUrl,
      ).map(async ([url, breakpointCommands]) => {
        await this._files.registerFile(url);
        const path = uriToPath(url);

        const breakpointDescriptors = breakpointCommands
          .map(c => ({
            lineNumber: c.params.lineNumber + 1,
            condition: c.params.condition || '',
          }))
          .concat(this._getBreakpointsForFilePath(path).map(bp => ({...bp})));

        const translatorBreakpoins = await this._setBreakpointsForFilePath(
          path,
          breakpointDescriptors,
        );

        return breakpointCommands.map((command, i) => {
          const {breakpointId, lineNumber, resolved} = translatorBreakpoins[i];

          const result = {
            breakpointId,
            locations: [nuclideDebuggerLocation(path, lineNumber - 1, 0)],
            resolved,
          };
          return {
            id: command.id,
            result,
          };
        });
      }),
    );
    return arrayFlatten(responseGroups);
  }

  _syncBreakpoints(): Promise<mixed> {
    const filePaths = new Set(
      Array.from(this._breakpointsById.values()).map(bp => bp.path),
    );
    const setBreakpointPromises = [];
    for (const filePath of filePaths) {
      setBreakpointPromises.push(
        this._setBreakpointsForFilePath(
          filePath,
          this._getBreakpointsForFilePath(filePath).map(bp => ({...bp})),
        ),
      );
    }
    return Promise.all(setBreakpointPromises);
  }

  async _configDone(): Promise<void> {
    await this._session.setExceptionBreakpoints({
      filters: this._exceptionFilters,
    });
    if (this._session.getCapabilities().supportsConfigurationDoneRequest) {
      await this._session.configurationDone();
    }
  }

  async _setBreakpointsForFilePath(
    path: NuclideUri,
    breakpoints: Array<BreakpointDescriptor>,
  ): Promise<Array<TranslatorBreakpoint>> {
    const source = {path, name: nuclideUri.basename(path)};
    const {
      body: {breakpoints: vsBreakpoints},
    } = await this._session.setBreakpoints({
      source,
      lines: breakpoints.map(bp => bp.lineNumber),
      breakpoints: breakpoints.map(bp => ({
        line: bp.lineNumber,
        condition: bp.condition,
      })),
    });
    if (vsBreakpoints.length !== breakpoints.length) {
      const errorMessage =
        'Failed to set breakpoints - count mismatch!' +
        ` ${vsBreakpoints.length} vs. ${breakpoints.length}`;
      this._logger.error(
        errorMessage,
        JSON.stringify(vsBreakpoints),
        JSON.stringify(breakpoints),
      );
      throw new Error(errorMessage);
    }
    return vsBreakpoints.map((vsBreakpoint, i) => {
      const bpDescriptior = breakpoints[i];
      const breakpointId =
        bpDescriptior.breakpointId ||
        String(vsBreakpoint.id) ||
        this._nextBreakpointId();
      const lineNumber = vsBreakpoint.line || bpDescriptior.lineNumber || -1;
      const resolved = vsBreakpoint.verified;
      const condition = breakpoints[i].condition;

      // Cache breakpoint info in the translator by id
      // for handling of removeBreakpoint by id requests.
      const translatorBreakpoint = {
        breakpointId,
        lineNumber,
        path,
        resolved,
        condition,
      };
      this._breakpointsById.set(breakpointId, translatorBreakpoint);
      return translatorBreakpoint;
    });
  }

  async _removeBreakpoint(
    breakpointId: NuclideDebugProtocol.BreakpointId,
  ): Promise<void> {
    const foundBreakpoint = this._breakpointsById.get(breakpointId);
    if (foundBreakpoint == null) {
      this._logger.info(`No breakpoint with id: ${breakpointId} to remove!`);
      return;
    }
    const remainingBreakpoints = this._getBreakpointsForFilePath(
      foundBreakpoint.path,
    ).filter(breakpoint => breakpoint.breakpointId !== breakpointId);
    this._breakpointsById.delete(breakpointId);

    await this._setBreakpointsForFilePath(
      foundBreakpoint.path,
      remainingBreakpoints.map(bp => ({
        ...bp,
      })),
    );
  }

  async _evaluateOnCallFrame(
    expression: string,
    frameId?: number,
  ): Promise<NuclideDebugProtocol.EvaluateResponse> {
    const {body} = await this._session.evaluate({
      expression,
      frameId,
    });
    return {
      result: {
        type: (body.type: any),
        value: body.result,
        description: body.result,
        objectId:
          body.variablesReference > 0
            ? String(body.variablesReference)
            : undefined,
      },
      wasThrown: false,
    };
  }

  _getBreakpointsForFilePath(path: NuclideUri): Array<TranslatorBreakpoint> {
    return Array.from(this._breakpointsById.values()).filter(
      breakpoint => breakpoint.path === path,
    );
  }

  _nextBreakpointId(): NuclideDebugProtocol.BreakpointId {
    return String(++this._lastBreakpointId);
  }

  _commandsOfType(
    type: string,
  ): Observable<NuclideDebugProtocol.DebuggerCommand> {
    this._handledCommands.add(type);
    return this._commands.filter(c => c.method === type);
  }

  _unhandledCommands(): Observable<NuclideDebugProtocol.DebuggerCommand> {
    return this._commands.filter(c => !this._handledCommands.has(c.method));
  }

  _listenToSessionEvents(): IDisposable {
    // The first resume command is the indicator of client readiness
    // to receive session events.
    return new UniversalDisposable(
      this._session.observeAllEvents().subscribe(event => {
        this._logger.info('VSP Event', event);
      }),
      this._session.observeThreadEvents().subscribe(({body}) => {
        const {reason, threadId} = body;
        if (reason === 'started') {
          if (this._mainThreadId == null) {
            this._mainThreadId = threadId;
          }
          this._updateThreadsState([threadId], 'running');
        } else if (reason === 'exited') {
          this._threadsById.delete(threadId);
          if (this._pausedThreadId === threadId) {
            this._pausedThreadId = null;
          }
          if (this._mainThreadId === threadId) {
            this._mainThreadId = null;
          }
        } else {
          this._logger.error('Unkown thread event:', body);
        }
        const threadsUpdatedEvent = this._getThreadsUpdatedEvent();
        this._sendMessageToClient({
          method: 'Debugger.threadsUpdated',
          params: threadsUpdatedEvent,
        });
      }),
      this._session.observeStopEvents().subscribe(({body}) => {
        const {threadId, allThreadsStopped, reason} = body;
        if (allThreadsStopped) {
          this._updateThreadsState(this._threadsById.keys(), 'paused');
          this._pausedThreadId = Array.from(this._threadsById.keys())[0];
        }
        if (threadId != null) {
          this._updateThreadsState([threadId], 'paused');
          this._pausedThreadId = threadId;
        }
        // Even though the python debugger engine pauses all threads,
        // It only reports the main thread as paused.
        if (
          this._adapterType === VsAdapterTypes.PYTHON &&
          reason === 'user request'
        ) {
          Array.from(this._threadsById.values()).forEach(
            threadInfo => (threadInfo.stopReason = reason),
          );
        }
      }),
      this._session
        .observeBreakpointEvents()
        .flatMap(async ({body}) => {
          const {breakpoint} = body;
          const hitCount = parseInt(breakpoint.nuclide_hitCount, 10);
          if (!Number.isNaN(hitCount) && breakpoint.id != null) {
            const changedEvent: NuclideDebugProtocol.BreakpointHitCountEvent = {
              breakpointId: String(breakpoint.id),
              hitCount,
            };
            return changedEvent;
          }
          return null;
        })
        .subscribe(changedEvent => {
          if (changedEvent != null) {
            this._sendMessageToClient({
              method: 'Debugger.breakpointHitCountChanged',
              params: changedEvent,
            });
          }
        }),
      this._session
        .observeStopEvents()
        .flatMap(async ({body}) => {
          const {threadId, reason} = body;
          let callFrames = [];
          const translatedStopReason = translateStopReason(reason);
          if (threadId != null) {
            callFrames = await this._getTranslatedCallFramesForThread(threadId);
            this._threadsById.set(threadId, {
              state: 'paused',
              callFrames,
              stopReason: translatedStopReason,
            });
          }
          const pausedEvent: NuclideDebugProtocol.PausedEvent = {
            callFrames,
            reason: translatedStopReason,
            stopThreadId: threadId,
            threadSwitchMessage: null,
          };

          const threadsUpdatedEvent = this._getThreadsUpdatedEvent();
          return {pausedEvent, threadsUpdatedEvent};
        })
        .subscribe(({pausedEvent, threadsUpdatedEvent}) => {
          this._sendMessageToClient({
            method: 'Debugger.paused',
            params: pausedEvent,
          });
          this._sendMessageToClient({
            method: 'Debugger.threadsUpdated',
            params: threadsUpdatedEvent,
          });
        }),
      this._session.observeContinuedEvents().subscribe(({body}) => {
        const {allThreadsContinued, threadId} = body;
        if (allThreadsContinued || threadId === this._pausedThreadId) {
          this._pausedThreadId = null;
        }

        if (allThreadsContinued) {
          this._updateThreadsState(this._threadsById.keys(), 'running');
        }
        if (threadId != null) {
          this._updateThreadsState([threadId], 'running');
        }
        this._sendMessageToClient({method: 'Debugger.resumed'});
      }),
      this._session.observeBreakpointEvents().subscribe(({body}) => {
        const {reason, breakpoint} = body;
        const existingBreakpoint = this._breakpointsById.get(
          String(breakpoint.id || -1),
        );
        if (
          existingBreakpoint != null &&
          !existingBreakpoint.resolved &&
          breakpoint.verified
        ) {
          this._sendMessageToClient({
            method: 'Debugger.breakpointResolved',
            params: {
              breakpointId: existingBreakpoint.breakpointId,
              location: nuclideDebuggerLocation(
                existingBreakpoint.path,
                existingBreakpoint.lineNumber - 1,
                0,
              ),
            },
          });
          return;
        }
        this._logger.info('Unhandled breakpoint event', reason, breakpoint);
      }),
      this._session.observeOutputEvents().subscribe(({body}) => {
        const category = body.category || 'console';
        const level = OUTPUT_CATEGORY_TO_LEVEL[category];
        const output = (body.output || '').replace(/\r?\n$/, '');
        if (level != null && output.length > 0) {
          this._sendUserOutputMessage(level, output);
        } else if (category === 'nuclide_notification') {
          invariant(body.data);
          this._sendAtomNotification(body.data.type, body.output);
        }
      }),
      this._session
        .observeInitializeEvents()
        // The first initialized event is used for breakpoint handling
        // and launch synchronization.
        .skip(1)
        // Next initialized events are session restarts.
        // Hence, we need to sync breakpoints & config done.
        .switchMap(async () => {
          await this._syncBreakpoints();
          await this._configDone();
        })
        .subscribe(
          () => this._logger.info('Session synced'),
          error => this._logger.error('Unable to sync session: ', error),
        ),
    );
  }

  _updateThreadsState(threadIds: Iterable<number>, state: ThreadState): void {
    for (const threadId of threadIds) {
      const threadInfo = this._threadsById.get(threadId);
      if (threadInfo == null || state === 'running') {
        this._threadsById.set(threadId, {state});
      } else {
        this._threadsById.set(threadId, {
          ...threadInfo,
          state,
        });
      }
    }
  }

  _getThreadsUpdatedEvent(): NuclideDebugProtocol.ThreadsUpdatedEvent {
    const threads = Array.from(
      this._threadsById.entries(),
    ).map(([id, {state, callFrames, stopReason}]) => {
      const topCallFrame = callFrames == null ? null : callFrames[0];
      const threadName = `Thread ${id}`;

      let address;
      let location;
      let hasSource;
      if (topCallFrame == null) {
        address = '';
        location = nuclideDebuggerLocation('N/A', 0, 0);
        hasSource = false;
      } else {
        address = topCallFrame.functionName;
        location = {...topCallFrame.location};
        hasSource = topCallFrame.hasSource === true;
      }

      return {
        id,
        name: threadName,
        description: threadName,
        address,
        location,
        stopReason: stopReason || 'running',
        hasSource,
      };
    });

    return {
      owningProcessId: VSP_PROCESS_ID,
      stopThreadId: this._pausedThreadId || -1,
      threads,
    };
  }

  initilize(): Promise<mixed> {
    return this._session.initialize({
      clientID: 'Nuclide',
      adapterID: 'python' /* TODO(most) */,
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsVariablePaging: false,
      supportsRunInTerminalRequest: false,
      pathFormat: 'path',
    });
  }

  processCommand(command: NuclideDebugProtocol.DebuggerCommand): void {
    this._commands.next(command);
  }

  async _getTranslatedCallFramesForThread(
    threadId: number,
  ): Promise<Array<NuclideDebugProtocol.CallFrame>> {
    const {body: {stackFrames}} = await this._session.stackTrace({
      threadId,
    });
    return Promise.all(
      stackFrames.map(async frame => {
        let scriptId;
        if (frame.source != null && frame.source.path != null) {
          scriptId = frame.source.path;
        } else {
          this._logger.error('Cannot find source/script of frame: ', frame);
          scriptId = 'N/A';
        }
        await this._files.registerFile(pathToUri(scriptId));
        return {
          callFrameId: String(frame.id),
          functionName: frame.name,
          location: nuclideDebuggerLocation(
            scriptId,
            frame.line - 1,
            frame.column - 1,
          ),
          hasSource: frame.source != null,
          scopeChain: await this._getScopesForFrame(frame.id),
          this: (undefined: any),
        };
      }),
    );
  }

  async _getScopesForFrame(
    frameId: number,
  ): Promise<Array<NuclideDebugProtocol.Scope>> {
    const {body: {scopes}} = await this._session.scopes({frameId});
    return scopes.map(scope => ({
      type: (scope.name: any),
      name: scope.name,
      object: {
        type: 'object',
        description: scope.name,
        objectId: String(scope.variablesReference),
      },
    }));
  }

  async _getProperties(
    id: number,
    params: NuclideDebugProtocol.GetPropertiesRequest,
  ): Promise<NuclideDebugProtocol.GetPropertiesResponse> {
    const variablesReference = Number(params.objectId);
    const {body: {variables}} = await this._session.variables({
      variablesReference,
    });
    const propertyDescriptors = variables.map(variable => {
      const value = {
        type: (variable.type: any),
        value: variable.value,
        description: variable.value,
        objectId:
          variable.variablesReference > 0
            ? String(variable.variablesReference)
            : undefined,
      };
      return {
        name: variable.name,
        value,
        configurable: false,
        enumerable: true,
      };
    });
    return {
      result: propertyDescriptors,
    };
  }

  _sendMessageToClient(
    message:
      | NuclideDebugProtocol.DebuggerResponse
      | NuclideDebugProtocol.DebuggerEvent,
  ): void {
    this._clientCallback.sendChromeMessage(JSON.stringify(message));
  }

  _sendAtomNotification(level: AtomNotificationType, message: string): void {
    this._clientCallback.sendAtomNotification(level, message);
  }

  _sendUserOutputMessage(level: OutputLevelType, text: string): void {
    const message: Message = {level, text};
    this._clientCallback.sendUserOutputMessage(JSON.stringify(message));
  }

  observeSessionEnd(): Observable<void> {
    return Observable.merge(
      this._session.observeExitedDebugeeEvents(),
      this._observeTerminatedDebugeeEvents(),
      this._session.observeAdapterExitedEvents(),
    ).map(() => undefined);
  }

  _observeTerminatedDebugeeEvents(): Observable<mixed> {
    const debugeeTerminated = this._session.observeTerminateDebugeeEvents();
    if (this._adapterType === VsAdapterTypes.PYTHON) {
      // The python adapter normally it sends one terminated event on exit.
      // However, in program crashes, it sends two terminated events:
      // One immediatelly, followed by the output events with the stack trace
      // & then the real terminated event.
      // TODO(t19793170): Remove the extra `TerminatedEvent` from `pythonVSCode`
      return debugeeTerminated.delay(1000);
    } else {
      return debugeeTerminated;
    }
  }

  dispose(): void {
    this._disposables.dispose();
  }
}
