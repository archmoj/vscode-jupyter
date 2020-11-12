// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

// tslint:disable:no-any max-func-body-length

import { expect } from 'chai';
import { instance, mock, when } from 'ts-mockito';
import * as typemoq from 'typemoq';
import { EventEmitter } from 'vscode';
import { ApplicationEnvironment } from '../../client/common/application/applicationEnvironment';
import { IApplicationShell } from '../../client/common/application/types';
import { Experiments } from '../../client/common/experiments/groups';
import { ExperimentService } from '../../client/common/experiments/service';
import { IBrowserService, IPersistentState, IPersistentStateFactory } from '../../client/common/types';
import { DataScienceSurveyBanner, DSSurveyStateKeys } from '../../client/datascience/dataScienceSurveyBanner';
import { NativeEditorProvider } from '../../client/datascience/notebookStorage/nativeEditorProvider';
import { INotebookEditor } from '../../client/datascience/types';

suite('DataScience Survey Banner', () => {
    let appShell: typemoq.IMock<IApplicationShell>;
    let browser: typemoq.IMock<IBrowserService>;
    const targetUri: string = 'https://microsoft.com';

    const message =
        'Can you please take 2 minutes to tell us how the Python Data Science features are working for you?';
    const yes = 'Yes, take survey now';
    const no = 'No, thanks';

    async function runTestAndVerifyResults(testBanner: DataScienceSurveyBanner) {
        const expectedUri: string = targetUri;
        let receivedUri: string = '';
        browser
            .setup((b) =>
                b.launch(
                    typemoq.It.is((a: string) => {
                        receivedUri = a;
                        return a === expectedUri;
                    })
                )
            )
            .verifiable(typemoq.Times.once());
        await testBanner.launchSurvey();
        // This is technically not necessary, but it gives
        // better output than the .verifyAll messages do.
        expect(receivedUri).is.equal(expectedUri, 'Uri given to launch mock is incorrect.');

        // verify that the calls expected were indeed made.
        browser.verifyAll();
        browser.reset();
    }

    setup(() => {
        appShell = typemoq.Mock.ofType<IApplicationShell>();
        browser = typemoq.Mock.ofType<IBrowserService>();
    });
    test('DataScience banner should be enabled after we hit our execution count', async () => {
        const enabledValue: boolean = true;
        const executionCount: number = 1000;
        const lastClickedSurvey = Date.now() - 3 * 31 * 24 * 60 * 60 * 1000;
        const testBanner: DataScienceSurveyBanner = preparePopup(
            executionCount,
            0,
            0,
            lastClickedSurvey,
            enabledValue,
            appShell.object,
            browser.object,
            targetUri
        );
        runTestAndVerifyResults(testBanner);
    });

    test('DataScience banner should be enabled after we hit our notebook count', async () => {
        const enabledValue: boolean = true;
        const lastClickedSurvey = Date.now() - 3 * 31 * 24 * 60 * 60 * 1000;
        const testBanner: DataScienceSurveyBanner = preparePopup(
            0,
            15,
            0,
            lastClickedSurvey,
            enabledValue,
            appShell.object,
            browser.object,
            targetUri
        );
        runTestAndVerifyResults(testBanner);
    });

    test('DataScience banner should be enabled after we hit our native notebooks insiders session count', async () => {
        const enabledValue: boolean = true;
        const insidersNativeNotebooksSessionCount = 10;
        const lastClickedSurvey = Date.now() - 3 * 31 * 24 * 60 * 60 * 1000;
        const testBanner = preparePopup(
            0,
            0,
            insidersNativeNotebooksSessionCount,
            lastClickedSurvey,
            enabledValue,
            appShell.object,
            browser.object,
            targetUri
        );
        runTestAndVerifyResults(testBanner);
    });

    test('Do not show data science banner if user last clicked survey less than 2 months ago', () => {
        const enabledValue: boolean = true;
        const insidersNativeNotebooksSessionCount = 10;
        const lastClickedSurvey = Date.now() - 1 * 31 * 24 * 60 * 60 * 1000;
        const testBanner = preparePopup(
            0,
            0,
            insidersNativeNotebooksSessionCount,
            lastClickedSurvey,
            enabledValue,
            appShell.object,
            browser.object,
            targetUri
        );
        testBanner.showBanner().ignoreErrors();
    });

    test('Do not show data science banner if we have not hit our execution count or our notebook count', () => {
        appShell
            .setup((a) =>
                a.showInformationMessage(typemoq.It.isValue(message), typemoq.It.isValue(yes), typemoq.It.isValue(no))
            )
            .verifiable(typemoq.Times.never());
        const enabledValue: boolean = true;
        const lastClickedSurvey = Date.now() - 3 * 31 * 24 * 60 * 60 * 1000;
        const testBanner: DataScienceSurveyBanner = preparePopup(
            99,
            4,
            0,
            lastClickedSurvey,
            enabledValue,
            appShell.object,
            browser.object,
            targetUri
        );
        testBanner.showBanner().ignoreErrors();
    });
});

function preparePopup(
    executionCount: number,
    initialOpenCount: number,
    insidersNativeNotebooksSessionCount: number,
    lastSurveyClickDateInMilliseconds: number,
    enabledValue: boolean,
    appShell: IApplicationShell,
    browser: IBrowserService,
    targetUri: string
): DataScienceSurveyBanner {
    let openCount = 0;
    const myfactory: typemoq.IMock<IPersistentStateFactory> = typemoq.Mock.ofType<IPersistentStateFactory>();
    const enabledValState: typemoq.IMock<IPersistentState<boolean>> = typemoq.Mock.ofType<IPersistentState<boolean>>();
    const executionCountState: typemoq.IMock<IPersistentState<number>> = typemoq.Mock.ofType<
        IPersistentState<number>
    >();
    const insidersNativeNotebooksSessionCountState: typemoq.IMock<IPersistentState<number>> = typemoq.Mock.ofType<
        IPersistentState<number>
    >();
    const lastSurveyClickDateInMillisecondsState: typemoq.IMock<IPersistentState<number>> = typemoq.Mock.ofType<
        IPersistentState<number>
    >();
    const openCountState: typemoq.IMock<IPersistentState<number>> = typemoq.Mock.ofType<IPersistentState<number>>();
    const provider = mock(NativeEditorProvider);
    (instance(provider) as any).then = undefined;
    const openedEventEmitter = new EventEmitter<INotebookEditor>();
    when(provider.onDidOpenNotebookEditor).thenReturn(openedEventEmitter.event);
    const appEnv = mock(ApplicationEnvironment);
    when(appEnv.channel).thenReturn('insiders');
    const expService = mock(ExperimentService);
    when(expService.inExperiment(Experiments.NativeNotebook)).thenResolve(true);
    enabledValState
        .setup((a) => a.updateValue(typemoq.It.isValue(true)))
        .returns(() => {
            enabledValue = true;
            return Promise.resolve();
        });
    enabledValState
        .setup((a) => a.updateValue(typemoq.It.isValue(false)))
        .returns(() => {
            enabledValue = false;
            return Promise.resolve();
        });

    executionCountState
        .setup((a) => a.updateValue(typemoq.It.isAnyNumber()))
        .returns(() => {
            executionCount += 1;
            return Promise.resolve();
        });
    insidersNativeNotebooksSessionCountState
        .setup((a) => a.updateValue(typemoq.It.isAnyNumber()))
        .returns(() => {
            insidersNativeNotebooksSessionCount += 1;
            return Promise.resolve();
        });
    openCountState
        .setup((a) => a.updateValue(typemoq.It.isAnyNumber()))
        .returns((v) => {
            openCount = v;
            return Promise.resolve();
        });
    lastSurveyClickDateInMillisecondsState
        .setup((a) => a.updateValue(typemoq.It.isAnyNumber()))
        .returns((v) => {
            openCount = v;
            return Promise.resolve();
        });

    enabledValState.setup((a) => a.value).returns(() => enabledValue);
    executionCountState.setup((a) => a.value).returns(() => executionCount);
    openCountState.setup((a) => a.value).returns(() => openCount);
    insidersNativeNotebooksSessionCountState.setup((a) => a.value).returns(() => insidersNativeNotebooksSessionCount);
    lastSurveyClickDateInMillisecondsState.setup((a) => a.value).returns(() => lastSurveyClickDateInMilliseconds);

    myfactory
        .setup((a) =>
            a.createGlobalPersistentState(typemoq.It.isValue(DSSurveyStateKeys.ShowBanner), typemoq.It.isValue(true))
        )
        .returns(() => {
            return enabledValState.object;
        });
    myfactory
        .setup((a) =>
            a.createGlobalPersistentState(typemoq.It.isValue(DSSurveyStateKeys.ShowBanner), typemoq.It.isValue(false))
        )
        .returns(() => {
            return enabledValState.object;
        });
    myfactory
        .setup((a) =>
            a.createGlobalPersistentState(
                typemoq.It.isValue(DSSurveyStateKeys.ExecutionCount),
                typemoq.It.isAnyNumber()
            )
        )
        .returns(() => {
            return executionCountState.object;
        });
    myfactory
        .setup((a) =>
            a.createGlobalPersistentState(
                typemoq.It.isValue(DSSurveyStateKeys.InsidersNativeNotebooksSessionCount),
                typemoq.It.isAnyNumber()
            )
        )
        .returns(() => {
            return insidersNativeNotebooksSessionCountState.object;
        });
    myfactory
        .setup((a) =>
            a.createGlobalPersistentState(
                typemoq.It.isValue(DSSurveyStateKeys.LastSurveyClickDateInMilliseconds),
                typemoq.It.isAnyNumber()
            )
        )
        .returns(() => {
            return lastSurveyClickDateInMillisecondsState.object;
        });
    myfactory
        .setup((a) =>
            a.createGlobalPersistentState(
                typemoq.It.isValue(DSSurveyStateKeys.OpenNotebookCount),
                typemoq.It.isAnyNumber()
            )
        )
        .returns(() => {
            return openCountState.object;
        });

    const result = new DataScienceSurveyBanner(
        appShell,
        myfactory.object,
        browser,
        instance(provider),
        instance(expService),
        instance(appEnv),
        targetUri
    );

    // Fire the number of opens specifed so that it behaves like the real editor
    for (let i = 0; i < initialOpenCount; i += 1) {
        openedEventEmitter.fire({} as any);
    }

    return result;
}
