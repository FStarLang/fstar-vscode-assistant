export interface fstarVSCodeAssistantSettings {
	verifyOnOpen: boolean;
	verifyOnSave: boolean;
	flyCheck: boolean;
	debug: boolean;
	showLightCheckIcon: boolean;
}

export const defaultSettings: fstarVSCodeAssistantSettings = {
	verifyOnOpen: false,
	verifyOnSave: true,
	flyCheck: true,
	debug: false,
	showLightCheckIcon: true
};
