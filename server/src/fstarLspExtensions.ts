import { ProtocolNotificationType, Position, Range } from 'vscode-languageserver-protocol';

export type StatusKind
	= 'ok'
	| 'lax-ok'
	| 'light-ok'
	| 'in-progress'
	| 'failed'
	| 'light-failed'
	| 'started';

export interface FragmentStatus {
	kind: StatusKind;
	range: Range;
}

export interface StatusNotificationParams {
	uri: string;
	fragments: FragmentStatus[];
}
export const statusNotification =
	new ProtocolNotificationType<StatusNotificationParams, RegistrationParams>('$/fstar/status');

export interface RestartParams {
	uri: string;
}
export const restartNotification =
	new ProtocolNotificationType<RestartParams, RegistrationParams>('$/fstar/restart');

export interface KillAndRestartSolverParams {
	uri: string;
}
export const killAndRestartSolverNotification =
	new ProtocolNotificationType<KillAndRestartSolverParams, RegistrationParams>('$/fstar/killAndRestartSolver');

export interface KillAllParams {}
export const killAllNotification =
	new ProtocolNotificationType<KillAllParams, RegistrationParams>('$/fstar/killAll');

export interface VerifyToPositionParams {
	uri: string;
	position: Position;
	lax: boolean;
}
export const verifyToPositionNotification =
	new ProtocolNotificationType<VerifyToPositionParams, RegistrationParams>('$/fstar/verifyToPosition');

interface RegistrationParams {}

export interface TelemetryEventProperties {
	readonly [key: string]: string | undefined
		| any; //apparently we need the safe type here??
}
export interface TelemetryEventMeasurements {
	readonly [key: string]: number | undefined;
}
export interface TelemetryNotificationParams {
	eventName: string;
	properties?: TelemetryEventProperties;
	measurements?: TelemetryEventMeasurements;
}
export const telemetryNotification =
	new ProtocolNotificationType<TelemetryNotificationParams, RegistrationParams>('$/fstar/telemetry');