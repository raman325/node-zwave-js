import path from "node:path";
import { type PluginConfig } from "ts-patch";
import ts, { type TransformerExtras } from "typescript";

/**
 * Transformer to replace @validateArgs() calls with the version
 * generated by the program transformer.
 *
 * This MUST be executed after the program transformer
 */
export default function transformer(
	program: ts.Program,
	pluginConfig: PluginConfig,
	{ ts: t }: TransformerExtras,
): ts.TransformerFactory<ts.SourceFile> {
	const compilerOptions = program.getCompilerOptions();
	// Only enable the transforms if the custom condition is not set
	// Not sure why, but otherwise the LSP has issues and moving the transforms
	// to tsconfig.build.json results in some type references not working
	const shouldTransform = !compilerOptions.customConditions?.includes("@@dev")
		|| compilerOptions.customConditions?.includes("@@test_transformers");

	return (context: ts.TransformationContext) => (file: ts.SourceFile) => {
		if (!shouldTransform) return file;

		// Bail early if there is no import for "@zwave-js/transformers". In this case, there's nothing to transform
		if (!file.getFullText().includes("@zwave-js/transformers")) {
			// if (options?.verbose) {
			// 	console.log(
			// 		`@zwave-js/transformers not imported in ${file.fileName}, skipping`,
			// 	);
			// }
			return file;
		}

		const f = context.factory;

		let className: string | undefined;
		let methodName: string | undefined;
		const renamedDecorators: ts.Identifier[] = [];

		function renameDecorators(node: ts.Node): ts.Node {
			if (t.isClassDeclaration(node) && node.name) {
				className = node.name.text;
				const ret = t.visitEachChild(node, renameDecorators, context);
				className = undefined;
				return ret;
			}

			if (className && t.isMethodDeclaration(node) && node.name) {
				methodName = node.name.getText();
				const ret = t.visitEachChild(node, renameDecorators, context);
				methodName = undefined;
				return ret;
			}

			if (
				className
				&& methodName
				&& t.isDecorator(node)
				&& t.isCallExpression(node.expression)
				&& t.isIdentifier(node.expression.expression)
				&& node.expression.expression.text === "validateArgs"
			) {
				const newName = f.createIdentifier(
					`validateArgs_${className}_${methodName}`,
				);
				renamedDecorators.push(newName);
				const newCallExpression = f.updateCallExpression(
					node.expression,
					newName,
					node.expression.typeArguments,
					node.expression.arguments,
				);
				return f.updateDecorator(node, newCallExpression);
			}

			return t.visitEachChild(node, renameDecorators, context);
		}
		file = t.visitNode(file, renameDecorators) as ts.SourceFile;

		// Remove @zwave-js/transformers import
		const selfImports = file.statements
			.filter((s) => ts.isImportDeclaration(s))
			.filter(
				(i) =>
					i.moduleSpecifier
						.getText(file)
						.replaceAll(/^["']|["']$/g, "")
						=== "@zwave-js/transformers",
			);

		// Create replacement import
		const extension = file.fileName.match(/\.[mc]?[jt]s$/)?.[0];
		const fileNameOnly = path.basename(file.fileName, extension);
		const newImport = f.createImportDeclaration(
			undefined,
			f.createImportClause(
				false,
				undefined,
				f.createNamespaceImport(f.createIdentifier("__validateArgs")),
			),
			f.createStringLiteral(
				`./${fileNameOnly}._validateArgs${
					file.impliedNodeFormat === ts.ModuleKind.ESNext
						&& extension?.replace("ts", "js") || ""
				}`,
			),
		);
		// We need to destructure the replacement import, because at this stage TS does
		// not understand that we're creating an import and use it later in the file
		const destructure = f.createVariableStatement(
			undefined,
			f.createVariableDeclarationList(
				[f.createVariableDeclaration(
					f.createObjectBindingPattern(
						renamedDecorators.map((d) =>
							f.createBindingElement(
								undefined,
								undefined,
								d,
								undefined,
							)
						),
					),
					undefined,
					undefined,
					f.createIdentifier("__validateArgs"),
				)],
				ts.NodeFlags.Const,
			),
		);

		if (selfImports.length > 0) {
			file = context.factory.updateSourceFile(
				file,
				[
					newImport,
					destructure,
					...file.statements.filter((s) =>
						!selfImports.includes(s as any)
					),
				],
				file.isDeclarationFile,
				file.referencedFiles,
				file.typeReferenceDirectives,
				file.hasNoDefaultLib,
				file.libReferenceDirectives,
			);
		}

		return file;
	};
}