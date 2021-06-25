// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import * as fs from 'fs';

const decorationType = vscode.window.createTextEditorDecorationType({
	backgroundColor: 'rgba(0,255,0,0.1)',
	opacity: '1',
	rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	overviewRulerColor: 'rgba(0,255,0,0.1)',
	overviewRulerLane: vscode.OverviewRulerLane.Center,
});

//Stores all the marks. Global, so we can store it 
let marksDict: { [filename: string]: { set: Set<{ start: number, end: number }> } } = {};
let workspaceStoragePath: vscode.Uri;
// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	let activeEditor = vscode.window.activeTextEditor;
	let notInWorkspace = true;
	//load the metadata file
	let path = context.storageUri;
	if (path !== undefined) {
		workspaceStoragePath = path;
		notInWorkspace = false;

		//create files if they are missing
		let marksPath = vscode.Uri.joinPath(path, "marks.json");
		let workspaceEdit = new vscode.WorkspaceEdit();
		workspaceEdit.createFile(marksPath, { ignoreIfExists: true });
		await vscode.workspace.applyEdit(workspaceEdit);

		let array = await vscode.workspace.fs.readFile(marksPath);
		try {
			let marksWithSetArray: { [filename: string]: { array: { start: number, end: number }[] } } = JSON.parse(new TextDecoder().decode(array));
			if (marksWithSetArray === undefined) {
				return;
			}
			for (let mark in marksWithSetArray) {
				let tempSet: Set<{ start: number, end: number }> = new Set();
				marksWithSetArray[mark].array.map(item => tempSet.add(item));

				marksDict[mark] = { set: tempSet };
			}
		} catch {

		}

		vscode.workspace.onDidSaveTextDocument(saveEvent => {
			let document = vscode.window.activeTextEditor?.document;
			if (document === undefined) {
				return;
			}
			if (saveEvent.fileName === document.fileName) {
				updateDecorations();
			};
		});
		vscode.window.onDidChangeActiveTextEditor(textEvent => {
			activeEditor = textEvent;
			let fileName = textEvent?.document.fileName;
			if (fileName !== undefined) {
				updateDecorations();
			}
		});
	}

	function updateDecorations() {
		try {
			vscode.window.visibleTextEditors.forEach((editor) => {
				let editorFile = editor?.document;
				if (editorFile === undefined) {
					return;
				}
				let relativeActiveFile = vscode.workspace.asRelativePath(editorFile.uri);
				if (relativeActiveFile in marksDict === false) {
					//delete, if some existed
					editor.setDecorations(decorationType, []);
					return;
				}
				let decorationsToAdd = [];
				let set = marksDict[relativeActiveFile].set;
				for (let selection of set) {
					let start = new vscode.Position(selection.start, 0);
					let end : vscode.Position;
					if(selection.end > editorFile.lineCount -1 ){
						//will get adjusted in validatePosition
						end = new vscode.Position(selection.end, 0);
					}else{
						end = editorFile.lineAt(selection.end).range.end;
					}
					let newStart = editor.document.validatePosition(start);
					let newEnd = editor.document.validatePosition(end);
					if (newStart !== start || newEnd !== end) {
						set.delete({ start: start.line, end: end.line });
						set.add({ start: newStart.line, end: newEnd.line });
					}
					let newDecoration = {
						range: new vscode.Range(
							newStart, newEnd)
					};
					decorationsToAdd.push(newDecoration);

				}
				editor.setDecorations(decorationType, decorationsToAdd);

			});
		}
		catch (error) {
			console.error("Error from ' updateDecorations' -->", error);
		}


	}

	function addMark(newRange: { start: number, end: number }, fileKey: string) {
		try {
			let set = marksDict[fileKey].set;
			let overlaps = [...set].filter(range =>
				(range.start <= (newRange.start - 1) && range.end >= (newRange.start - 1)) ||
				((range.start - 1) >= newRange.start && (range.start - 1) <= newRange.end)
			);
			if (overlaps.length === 0) {
				//just add to array; no conflicting entries
				set.add(newRange);
				return;
			}
			//we have to merge the collisions
			for (let overlap of overlaps) {
				set.delete(overlap);
			}
			overlaps.push(newRange);
			let min = overlaps[0].start;
			let max = overlaps[0].end;
			for (let overlap of overlaps) {
				min = Math.min(overlap.start, min);
				max = Math.max(overlap.end, max);
			}

			set.add({ start: min, end: max });
		}
		catch (error) {
			console.error("Error from ' updateDecorations' -->", error);
		}
	}

	function removeMark(removeRange: { start: number, end: number }, fileKey: string) {
		try {
			let set = marksDict[fileKey].set;
			let overlaps = [...set].filter(range =>
				(range.start <= removeRange.start && range.end >= removeRange.start) ||
				(range.start >= removeRange.start && range.start <= removeRange.end)
			);
			if (overlaps.length === 0) {
				//Nothing to remove
				return;
			}
			for (let overlap of overlaps) {
				//different cases:
				if (overlap.start >= removeRange.start && overlap.end <= removeRange.end) {
					//4. the remove range overspans the overlap
					set.delete(overlap);
				} else if (overlap.start <= removeRange.start && overlap.end >= removeRange.end) {
					//split up
					set.delete(overlap);
					if ((removeRange.start - 1) - overlap.start >= 0) {
						set.add({ start: overlap.start, end: removeRange.start - 1 });
					}
					if (overlap.end - (removeRange.end + 1) >= 0) {
						set.add({ start: removeRange.end + 1, end: overlap.end });
					}
				} else if (overlap.start <= removeRange.start && overlap.end < removeRange.end && overlap.end >= removeRange.start) {
					//2. it is bigger on the right
					set.delete(overlap);
					set.add({ start: overlap.start, end: removeRange.start - 1 });
				} else if (overlap.start > removeRange.start && overlap.end >= removeRange.end && overlap.start <= removeRange.end) {
					//3. it is bigger on the left
					set.delete(overlap);
					set.add({ start: removeRange.end + 1, end: overlap.end });
				}
			}
		}
		catch (error) {
			console.error("Error from ' updateDecorations' -->", error);
		}
	}

	async function saveAndUpdateMarks(){
		if (workspaceStoragePath !== undefined) {
			updateDecorations();
			try {
				let marksPath = vscode.Uri.joinPath(workspaceStoragePath, "marks.json");
				let marksWithSetArray: { [filename: string]: { array: { start: number, end: number }[] } } = {};
				for (let mark in marksDict) {
					marksWithSetArray[mark] = { array: [...marksDict[mark].set] };
				}
				let marksJson = JSON.stringify(marksWithSetArray);
	
				fs.writeFile(marksPath.fsPath, marksJson, () => {});
			} catch (e) {
				console.error(e);
			}
		}
	}

	let mark = vscode.commands.registerCommand('auditmark.mark', async () => {

		if (notInWorkspace) {
			vscode.window.showErrorMessage("Please open the file in a workspace!");
		} else {
			let selections = vscode.window.activeTextEditor?.selections;
			let markedFile = vscode.window.activeTextEditor?.document;
			if (selections === undefined || markedFile === undefined) {
				return;
			}
			await markedFile.save();
			let realtiveFilePath = vscode.workspace.asRelativePath(markedFile.uri);
			if (realtiveFilePath in marksDict === false) {
				marksDict[realtiveFilePath] = { set: new Set() };
			}

			for (let selection of selections) {
				let newRange = { start: Math.min(selection.active.line, selection.anchor.line), end: Math.max(selection.active.line, selection.anchor.line) };
				addMark(newRange, realtiveFilePath);
			}
			await saveAndUpdateMarks();
		}
	});

	let unmark = vscode.commands.registerCommand('auditmark.unmark', async () => {

		if (notInWorkspace) {
			vscode.window.showErrorMessage("Please open the file in a workspace!");
		} else {
			let selections = vscode.window.activeTextEditor?.selections;
			let markedFile = vscode.window.activeTextEditor?.document;
			if (selections === undefined || markedFile === undefined) {
				return;
			}
			let realtiveFilePath = vscode.workspace.asRelativePath(markedFile.uri);
			if (realtiveFilePath in marksDict === false) {
				return;
			}
			for (let selection of selections) {
				let removeRange = { start: Math.min(selection.active.line, selection.anchor.line), end: Math.max(selection.active.line, selection.anchor.line) };
				removeMark(removeRange, realtiveFilePath);

			}
			await saveAndUpdateMarks();
		}
	});

	let markFile = vscode.commands.registerCommand('auditmark.markfile', async () => {

		if (notInWorkspace) {
			vscode.window.showErrorMessage("Please open the file in a workspace!");
		} else {
			let markedFile = vscode.window.activeTextEditor?.document;
			if (markedFile === undefined) {
				return;
			}
			await markedFile.save();
			let realtiveFilePath = vscode.workspace.asRelativePath(markedFile.uri);
			if (realtiveFilePath in marksDict === false) {
				marksDict[realtiveFilePath] = { set: new Set() };
			}
			addMark({ start: 0, end: markedFile.lineCount - 1 }, realtiveFilePath);
			await saveAndUpdateMarks();
		}
	});

	let unmarkFile = vscode.commands.registerCommand('auditmark.unmarkfile', async () => {

		if (notInWorkspace) {
			vscode.window.showErrorMessage("Please open the file in a workspace!");
		} else {
			let markedFile = vscode.window.activeTextEditor?.document;
			if (markedFile === undefined) {
				return;
			}
			let realtiveFilePath = vscode.workspace.asRelativePath(markedFile.uri);
			if(!(realtiveFilePath in marksDict)){
				return;
			}
			marksDict[realtiveFilePath] = { set: new Set() };
			await saveAndUpdateMarks();
		}
	});

	let unmarkWorkspace = vscode.commands.registerCommand('auditmark.unmarkworkspace', async () => {

		if (notInWorkspace) {
			vscode.window.showErrorMessage("Please open the file in a workspace!");
		} else {
			marksDict = {};
			await saveAndUpdateMarks();
		}
	});

	context.subscriptions.push(mark);
	context.subscriptions.push(unmark);
	context.subscriptions.push(markFile);
	context.subscriptions.push(unmarkFile);
	context.subscriptions.push(unmarkWorkspace);
	updateDecorations();
}

// this method is called when your extension is deactivated

export async function deactivate() {
	//save the marks
	if (workspaceStoragePath !== undefined) {
		try {
			let marksPath = vscode.Uri.joinPath(workspaceStoragePath, "marks.json");
			let marksWithSetArray: { [filename: string]: { array: { start: number, end: number }[] } } = {};
			for (let mark in marksDict) {
				marksWithSetArray[mark] = { array: [...marksDict[mark].set] };
			}
			let marksJson = JSON.stringify(marksWithSetArray);

			fs.writeFile(marksPath.fsPath, marksJson, () => {});
			//await vscode.workspace.fs.writeFile(vscode.Uri.file(marksPath.path), new TextEncoder().encode(marks_json));
		} catch (e) {
			console.error(e);
		}
	}
}
