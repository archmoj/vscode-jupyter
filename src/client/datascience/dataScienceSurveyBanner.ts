// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject, injectable, named } from 'inversify';
import { env, Event, EventEmitter, UIKind } from 'vscode';
import { IApplicationEnvironment, IApplicationShell } from '../common/application/types';
import { Experiments } from '../common/experiments/groups';
import '../common/extensions';
import {
    BANNER_NAME_DS_SURVEY,
    IBrowserService,
    IExperimentService,
    IJupyterExtensionBanner,
    IPersistentStateFactory
} from '../common/types';
import * as localize from '../common/utils/localize';
import { noop } from '../common/utils/misc';
import { InteractiveWindowMessages, IReExecuteCells } from './interactive-common/interactiveWindowTypes';
import { IInteractiveWindowListener, INotebookEditorProvider } from './types';

export enum DSSurveyStateKeys {
    ShowBanner = 'ShowDSSurveyBanner',
    OpenNotebookCount = 'DS_OpenNotebookCount',
    ExecutionCount = 'DS_ExecutionCount',
    InsidersNativeNotebooksSessionCount = 'DS_NativeSessionCount',
    LastSurveyClickDateInMilliseconds = 'DS_LastSurveyClickDateInMilliseconds'
}

enum DSSurveyLabelIndex {
    Yes,
    No
}

const NotebookOpenThreshold = 5;
const NotebookExecutionThreshold = 100;

@injectable()
export class DataScienceSurveyBannerLogger implements IInteractiveWindowListener {
    // tslint:disable-next-line: no-any
    private postEmitter = new EventEmitter<{ message: string; payload: any }>();
    constructor(
        @inject(IPersistentStateFactory) private persistentState: IPersistentStateFactory,
        @inject(IJupyterExtensionBanner)
        @named(BANNER_NAME_DS_SURVEY)
        private readonly dataScienceSurveyBanner: IJupyterExtensionBanner
    ) {}
    // tslint:disable-next-line: no-any
    public get postMessage(): Event<{ message: string; payload: any }> {
        return this.postEmitter.event;
    }
    // tslint:disable-next-line: no-any
    public onMessage(message: string, payload?: any): void {
        if (message === InteractiveWindowMessages.ReExecuteCells) {
            const args = payload as IReExecuteCells;
            if (args && args.cellIds.length) {
                const state = this.persistentState.createGlobalPersistentState<number>(
                    DSSurveyStateKeys.ExecutionCount,
                    0
                );
                state
                    .updateValue(state.value + args.cellIds.length)
                    .then(() => {
                        // On every update try to show the banner.
                        return this.dataScienceSurveyBanner.showBanner();
                    })
                    .ignoreErrors();
            }
        }
    }
    public dispose(): void | undefined {
        noop();
    }
}

@injectable()
export class DataScienceSurveyBanner implements IJupyterExtensionBanner {
    private disabledInCurrentSession: boolean = false;
    private bannerMessage: string = localize.DataScienceSurveyBanner.bannerMessage();
    private bannerLabels: string[] = [
        localize.DataScienceSurveyBanner.bannerLabelYes(),
        localize.DataScienceSurveyBanner.bannerLabelNo()
    ];
    private readonly surveyLink: string;

    constructor(
        @inject(IApplicationShell) private appShell: IApplicationShell,
        @inject(IPersistentStateFactory) private persistentState: IPersistentStateFactory,
        @inject(IBrowserService) private browserService: IBrowserService,
        @inject(INotebookEditorProvider) editorProvider: INotebookEditorProvider,
        @inject(IExperimentService) private experimentService: IExperimentService,
        @inject(IApplicationEnvironment) private applicationEnvironment: IApplicationEnvironment,
        surveyLink: string = 'https://aka.ms/vscjupyternb'
    ) {
        this.surveyLink = surveyLink;
        this.incrementInsidersNativeNotebooksSessionCount().ignoreErrors();
        editorProvider.onDidOpenNotebookEditor(this.openedNotebook.bind(this));
    }

    private get isCodespaces(): boolean {
        return env.uiKind === UIKind?.Web;
    }

    public async showBanner(): Promise<void> {
        const executionCount: number = this.getExecutionCount();
        const notebookCount: number = this.getOpenNotebookCount();
        const insidersNativeNotebooksSessionCount = await this.getInsidersNativeNotebooksSessionCount();
        const show = await this.shouldShowBanner(executionCount, notebookCount, insidersNativeNotebooksSessionCount);
        if (!show) {
            return;
        }

        const response = await this.appShell.showInformationMessage(this.bannerMessage, ...this.bannerLabels);
        await this.resetElapsedNativeSessionCount();
        switch (response) {
            case this.bannerLabels[DSSurveyLabelIndex.Yes]: {
                await this.launchSurvey();
                await this.updateLastSurveyClickDate();
                break;
            }
            case this.bannerLabels[DSSurveyLabelIndex.No]: {
                break;
            }
            default: {
                // Disable for the current session.
                this.disabledInCurrentSession = true;
            }
        }
    }

    public async shouldShowBanner(
        executionCount: number,
        notebookOpenCount: number,
        insidersNativeNotebooksSessionCount: number
    ): Promise<boolean> {
        if (this.isCodespaces || this.disabledInCurrentSession || (await this.didClickSurveyLessThanTwoMonthsAgo())) {
            return false;
        }

        return (
            executionCount >= NotebookExecutionThreshold ||
            notebookOpenCount > NotebookOpenThreshold ||
            insidersNativeNotebooksSessionCount >= 10
        );
    }

    public async resetElapsedNativeSessionCount(): Promise<void> {
        await this.persistentState
            .createGlobalPersistentState<number>(DSSurveyStateKeys.InsidersNativeNotebooksSessionCount, 0)
            .updateValue(0);
    }

    public async launchSurvey(): Promise<void> {
        this.browserService.launch(this.surveyLink);
    }

    private getOpenNotebookCount(): number {
        const state = this.persistentState.createGlobalPersistentState<number>(DSSurveyStateKeys.OpenNotebookCount, 0);
        return state.value;
    }

    private getExecutionCount(): number {
        const state = this.persistentState.createGlobalPersistentState<number>(DSSurveyStateKeys.ExecutionCount, 0);
        return state.value;
    }

    private async getInsidersNativeNotebooksSessionCount(): Promise<number> {
        const state = this.persistentState.createGlobalPersistentState<number>(
            DSSurveyStateKeys.InsidersNativeNotebooksSessionCount,
            0
        );
        return state.value;
    }

    private async incrementInsidersNativeNotebooksSessionCount() {
        const state = this.persistentState.createGlobalPersistentState<number>(
            DSSurveyStateKeys.InsidersNativeNotebooksSessionCount,
            0
        );
        if (
            (await this.experimentService.inExperiment(Experiments.NativeNotebook)) &&
            this.applicationEnvironment.channel === 'insiders'
        ) {
            await state.updateValue(state.value + 1);
        }
    }

    private async updateLastSurveyClickDate() {
        await this.persistentState
            .createGlobalPersistentState<number>(DSSurveyStateKeys.LastSurveyClickDateInMilliseconds)
            .updateValue(Date.now());
    }

    private async didClickSurveyLessThanTwoMonthsAgo() {
        const now = Date.now();
        const lastClickedDate = this.persistentState.createGlobalPersistentState<number>(
            DSSurveyStateKeys.LastSurveyClickDateInMilliseconds,
            now
        ).value;
        const twoMonthsInMilliseconds = 2 * 31 * 24 * 60 * 60 * 1000;
        return now - lastClickedDate < twoMonthsInMilliseconds;
    }

    private async openedNotebook() {
        const state = this.persistentState.createGlobalPersistentState<number>(DSSurveyStateKeys.OpenNotebookCount, 0);
        await state.updateValue(state.value + 1);
        return this.showBanner();
    }
}
