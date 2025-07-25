import type { CCEncodingContext, CCParsingContext } from "@zwave-js/cc";
import {
	CommandClasses,
	Duration,
	type GetValueDB,
	type MaybeNotKnown,
	type MaybeUnknown,
	type MessageOrCCLogEntry,
	MessagePriority,
	type MessageRecord,
	NOT_KNOWN,
	type SupervisionResult,
	SupervisionStatus,
	ValueMetadata,
	type WithAddress,
	maybeUnknownToString,
	parseMaybeNumber,
	validatePayload,
} from "@zwave-js/core";
import { Bytes, getEnumMemberName, pick } from "@zwave-js/shared";
import { validateArgs } from "@zwave-js/transformers";
import {
	CCAPI,
	POLL_VALUE,
	type PollValueImplementation,
	SET_VALUE,
	SET_VALUE_HOOKS,
	type SetValueImplementation,
	type SetValueImplementationHooksFactory,
	throwUnsupportedProperty,
	throwWrongValueType,
} from "../lib/API.js";
import {
	multilevelSwitchTypeProperties,
	multilevelSwitchTypeToActions,
} from "../lib/CCValueUtils.js";
import {
	type CCRaw,
	CommandClass,
	type InterviewContext,
	type PersistValuesContext,
	type RefreshValuesContext,
	getEffectiveCCVersion,
} from "../lib/CommandClass.js";
import {
	API,
	CCCommand,
	ccValueProperty,
	ccValues,
	commandClass,
	expectedCCResponse,
	implementedVersion,
	useSupervision,
} from "../lib/CommandClassDecorators.js";
import { V } from "../lib/Values.js";
import {
	LevelChangeDirection,
	MultilevelSwitchCommand,
	SwitchType,
} from "../lib/_Types.js";

export const MultilevelSwitchCCValues = V.defineCCValues(
	CommandClasses["Multilevel Switch"],
	{
		...V.staticProperty(
			"currentValue",
			{
				...ValueMetadata.ReadOnlyLevel,
				label: "Current value",
			} as const,
		),
		...V.staticProperty(
			"targetValue",
			{
				...ValueMetadata.Level,
				label: "Target value",
				valueChangeOptions: ["transitionDuration"],
			} as const,
		),
		...V.staticProperty(
			"duration",
			{
				...ValueMetadata.ReadOnlyDuration,
				label: "Remaining duration",
			} as const,
		),
		...V.staticProperty(
			"restorePrevious",
			{
				...ValueMetadata.WriteOnlyBoolean,
				label: "Restore previous value",
				states: {
					true: "Restore",
				},
			} as const,
		),
		...V.staticPropertyWithName(
			"compatEvent",
			"event",
			{
				...ValueMetadata.ReadOnlyUInt8,
				label: "Event value",
			} as const,
			{
				stateful: false,
				autoCreate: (applHost, endpoint) =>
					!!applHost.getDeviceConfig?.(endpoint.nodeId)?.compat
						?.treatMultilevelSwitchSetAsEvent,
			},
		),
		...V.staticProperty("switchType", undefined, { internal: true }),
		...V.staticProperty("superviseStartStopLevelChange", undefined, {
			internal: true,
			supportsEndpoints: false,
		}),
		...V.dynamicPropertyWithName(
			"levelChangeUp",
			// This is called "up" here, but the actual property name will depend on
			// the given switch type
			(switchType: SwitchType) => {
				const switchTypeName = getEnumMemberName(
					SwitchType,
					switchType,
				);
				const [, up] = multilevelSwitchTypeToActions(switchTypeName);
				return up;
			},
			({ property }) =>
				typeof property === "string"
				&& multilevelSwitchTypeProperties.indexOf(property) % 2 === 1,
			(switchType: SwitchType) => {
				const switchTypeName = getEnumMemberName(
					SwitchType,
					switchType,
				);
				const [, up] = multilevelSwitchTypeToActions(switchTypeName);
				return {
					...ValueMetadata.WriteOnlyBoolean,
					label: `Perform a level change (${up})`,
					valueChangeOptions: ["transitionDuration"],
					states: {
						true: "Start",
						false: "Stop",
					},
					ccSpecific: { switchType },
				} as const;
			},
		),
		...V.dynamicPropertyWithName(
			"levelChangeDown",
			// This is called "down" here, but the actual property name will depend on
			// the given switch type
			(switchType: SwitchType) => {
				const switchTypeName = getEnumMemberName(
					SwitchType,
					switchType,
				);
				const [down] = multilevelSwitchTypeToActions(switchTypeName);
				return down;
			},
			({ property }) =>
				typeof property === "string"
				&& multilevelSwitchTypeProperties.indexOf(property) % 2 === 0,
			(switchType: SwitchType) => {
				const switchTypeName = getEnumMemberName(
					SwitchType,
					switchType,
				);
				const [down] = multilevelSwitchTypeToActions(switchTypeName);
				return {
					...ValueMetadata.WriteOnlyBoolean,
					label: `Perform a level change (${down})`,
					valueChangeOptions: ["transitionDuration"],
					states: {
						true: "Start",
						false: "Stop",
					},
					ccSpecific: { switchType },
				} as const;
			},
		),
	},
);

@API(CommandClasses["Multilevel Switch"])
export class MultilevelSwitchCCAPI extends CCAPI {
	public supportsCommand(
		cmd: MultilevelSwitchCommand,
	): MaybeNotKnown<boolean> {
		switch (cmd) {
			case MultilevelSwitchCommand.Get:
				return this.isSinglecast();
			case MultilevelSwitchCommand.Set:
			case MultilevelSwitchCommand.StartLevelChange:
			case MultilevelSwitchCommand.StopLevelChange:
				return true; // This is mandatory
			case MultilevelSwitchCommand.SupportedGet:
				return this.version >= 3 && this.isSinglecast();
		}
		return super.supportsCommand(cmd);
	}

	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	public async get() {
		this.assertSupportsCommand(
			MultilevelSwitchCommand,
			MultilevelSwitchCommand.Get,
		);

		const cc = new MultilevelSwitchCCGet({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
		});
		const response = await this.host.sendCommand<
			MultilevelSwitchCCReport
		>(
			cc,
			this.commandOptions,
		);
		if (response) {
			return pick(response, ["currentValue", "targetValue", "duration"]);
		}
	}

	/**
	 * Sets the switch to a new value
	 * @param targetValue The new target value for the switch
	 * @param duration The duration after which the target value should be reached. Can be a Duration instance or a user-friendly duration string like `"1m17s"`. Only supported in V2 and above.
	 * @returns A promise indicating whether the command was completed
	 */
	@validateArgs()
	public async set(
		targetValue: number,
		duration?: Duration | string,
	): Promise<SupervisionResult | undefined> {
		this.assertSupportsCommand(
			MultilevelSwitchCommand,
			MultilevelSwitchCommand.Set,
		);

		const cc = new MultilevelSwitchCCSet({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
			targetValue,
			duration,
		});
		return this.host.sendCommand(cc, this.commandOptions);
	}

	@validateArgs()
	public async startLevelChange(
		options: MultilevelSwitchCCStartLevelChangeOptions,
	): Promise<SupervisionResult | undefined> {
		this.assertSupportsCommand(
			MultilevelSwitchCommand,
			MultilevelSwitchCommand.StartLevelChange,
		);

		const cc = new MultilevelSwitchCCStartLevelChange({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
			...options,
		});

		return this.host.sendCommand(cc, this.commandOptions);
	}

	public async stopLevelChange(): Promise<SupervisionResult | undefined> {
		this.assertSupportsCommand(
			MultilevelSwitchCommand,
			MultilevelSwitchCommand.StopLevelChange,
		);

		const cc = new MultilevelSwitchCCStopLevelChange({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
		});

		return this.host.sendCommand(cc, this.commandOptions);
	}

	public async getSupported(): Promise<MaybeNotKnown<SwitchType>> {
		this.assertSupportsCommand(
			MultilevelSwitchCommand,
			MultilevelSwitchCommand.SupportedGet,
		);

		const cc = new MultilevelSwitchCCSupportedGet({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
		});
		const response = await this.host.sendCommand<
			MultilevelSwitchCCSupportedReport
		>(
			cc,
			this.commandOptions,
		);
		return response?.switchType;
	}

	protected override get [SET_VALUE](): SetValueImplementation {
		return async function(
			this: MultilevelSwitchCCAPI,
			{ property },
			value,
			options,
		) {
			// Enable restoring the previous non-zero value
			if (property === "restorePrevious") {
				property = "targetValue";
				value = 255;
			}

			if (property === "targetValue") {
				if (typeof value !== "number") {
					throwWrongValueType(
						this.ccId,
						property,
						"number",
						typeof value,
					);
				}
				const duration = Duration.from(options?.transitionDuration);
				return this.set(value, duration);
			} else if (
				multilevelSwitchTypeProperties.includes(property as string)
			) {
				// Since the switch only supports one of the switch types, we would
				// need to check if the correct one is used. But since the names are
				// purely cosmetic, we just accept all of them
				if (typeof value !== "boolean") {
					throwWrongValueType(
						this.ccId,
						property,
						"number",
						typeof value,
					);
				}
				if (value) {
					// The property names are organized so that positive motions are
					// at odd indices and negative motions at even indices
					const direction = multilevelSwitchTypeProperties.indexOf(
									property as string,
								) % 2
							=== 0
						? "down"
						: "up";
					// Singlecast only: Try to retrieve the current value to use as the start level,
					// even if the target node is going to ignore it. There might
					// be some bugged devices that ignore the ignore start level flag.
					const startLevel = this.tryGetValueDB()?.getValue<
						MaybeUnknown<number>
					>(
						MultilevelSwitchCCValues.currentValue.endpoint(
							this.endpoint.index,
						),
					);
					// And perform the level change
					const duration = Duration.from(options?.transitionDuration);
					return this.startLevelChange({
						direction,
						ignoreStartLevel: true,
						startLevel: typeof startLevel === "number"
							? startLevel
							: undefined,
						duration,
					});
				} else {
					return this.stopLevelChange();
				}
			} else {
				throwUnsupportedProperty(this.ccId, property);
			}
		};
	}

	protected [SET_VALUE_HOOKS]: SetValueImplementationHooksFactory = (
		{ property },
		value,
		options,
	) => {
		// Enable restoring the previous non-zero value
		if (property === "restorePrevious") {
			property = "targetValue";
			value = 255;
		}

		if (property === "targetValue") {
			const duration = Duration.from(options?.transitionDuration);
			const currentValueValueId = MultilevelSwitchCCValues.currentValue
				.endpoint(
					this.endpoint.index,
				);

			return {
				// Multilevel Switch commands may take some time to be executed.
				// Therefore we try to supervise the command execution and delay the
				// optimistic update until the final result is received.
				supervisionDelayedUpdates: true,
				supervisionOnSuccess: async () => {
					// Only update currentValue for valid target values
					if (
						typeof value === "number"
						&& value >= 0
						&& value <= 99
					) {
						this.tryGetValueDB()?.setValue(
							currentValueValueId,
							value,
						);
					} else if (value === 255) {
						// We don't know the status now, so refresh the current value
						try {
							await this.get();
						} catch {
							// ignore
						}
					}
				},
				supervisionOnFailure: async () => {
					// The transition failed, so now we don't know the status - refresh the current value
					try {
						await this.get();
					} catch {
						// ignore
					}
				},
				optimisticallyUpdateRelatedValues: (
					_supervisedAndSuccessful,
				) => {
					// Only update currentValue for valid target values
					if (
						typeof value === "number"
						&& value >= 0
						&& value <= 99
					) {
						if (this.isSinglecast()) {
							this.tryGetValueDB()?.setValue(
								currentValueValueId,
								value,
							);
						} else if (this.isMulticast()) {
							// Figure out which nodes were affected by this command
							const affectedNodes = this.endpoint.node
								.physicalNodes.filter(
									(node) =>
										node
											.getEndpoint(this.endpoint.index)
											?.supportsCC(this.ccId),
								);
							// and optimistically update the currentValue
							for (const node of affectedNodes) {
								this.host
									.tryGetValueDB(node.id)
									?.setValue(currentValueValueId, value);
							}
						}
					}
				},
				forceVerifyChanges: () => {
					// If we don't know the actual value, we need to verify the change, regardless of the supervision result
					return value === 255;
				},
				verifyChanges: async (result) => {
					if (
						// We generally don't want to poll for multicasts because of how much traffic it can cause
						// However, when setting the value 255 (ON), we don't know the actual state
						!(this.isSinglecast()
							|| (this.isMulticast() && value === 255))
					) {
						return;
					}

					switch (result?.status) {
						case SupervisionStatus.Success:
						case SupervisionStatus.Fail:
							await this.pollValue!(currentValueValueId);
							break;
						case SupervisionStatus.Working:
						default: // (not supervised)
							(this as this).schedulePoll(
								currentValueValueId,
								value === 255 ? undefined : value,
								{
									duration: result?.remainingDuration
										?? duration,
								},
							);
							break;
					}
				},
			};
		}
	};

	protected get [POLL_VALUE](): PollValueImplementation {
		return async function(this: MultilevelSwitchCCAPI, { property }) {
			switch (property) {
				case "currentValue":
				case "targetValue":
				case "duration":
					return (await this.get())?.[property];
				default:
					throwUnsupportedProperty(this.ccId, property);
			}
		};
	}
}

@commandClass(CommandClasses["Multilevel Switch"])
@implementedVersion(4)
@ccValues(MultilevelSwitchCCValues)
export class MultilevelSwitchCC extends CommandClass {
	declare ccCommand: MultilevelSwitchCommand;

	public async interview(
		ctx: InterviewContext,
	): Promise<void> {
		const node = this.getNode(ctx)!;
		const endpoint = this.getEndpoint(ctx)!;
		const api = CCAPI.create(
			CommandClasses["Multilevel Switch"],
			ctx,
			endpoint,
		).withOptions({
			priority: MessagePriority.NodeQuery,
		});

		ctx.logNode(node.id, {
			endpoint: this.endpointIndex,
			message: `Interviewing ${this.ccName}...`,
			direction: "none",
		});

		if (api.version >= 3) {
			// Find out which kind of switch this is
			ctx.logNode(node.id, {
				endpoint: this.endpointIndex,
				message: "requesting switch type...",
				direction: "outbound",
			});
			const switchType = await api.getSupported();
			if (switchType != undefined) {
				ctx.logNode(node.id, {
					endpoint: this.endpointIndex,
					message: `has switch type ${
						getEnumMemberName(
							SwitchType,
							switchType,
						)
					}`,
					direction: "inbound",
				});
			}
		} else {
			// requesting the switch type automatically creates the up/down actions
			// We need to do this manually for V1 and V2
			this.createMetadataForLevelChangeActions(ctx);
		}

		await this.refreshValues(ctx);

		// Remember that the interview is complete
		this.setInterviewComplete(ctx, true);
	}

	public async refreshValues(
		ctx: RefreshValuesContext,
	): Promise<void> {
		const node = this.getNode(ctx)!;
		const endpoint = this.getEndpoint(ctx)!;
		const api = CCAPI.create(
			CommandClasses["Multilevel Switch"],
			ctx,
			endpoint,
		).withOptions({
			priority: MessagePriority.NodeQuery,
		});

		ctx.logNode(node.id, {
			endpoint: this.endpointIndex,
			message: "requesting current switch state...",
			direction: "outbound",
		});
		await api.get();
	}

	public setMappedBasicValue(
		ctx: GetValueDB,
		value: number,
	): boolean {
		this.setValue(ctx, MultilevelSwitchCCValues.currentValue, value);
		return true;
	}

	protected createMetadataForLevelChangeActions(
		ctx: GetValueDB,
		// SDS13781: The Primary Switch Type SHOULD be 0x02 (Up/Down)
		switchType: SwitchType = SwitchType["Down/Up"],
	): void {
		this.ensureMetadata(
			ctx,
			MultilevelSwitchCCValues.levelChangeUp(switchType),
		);
		this.ensureMetadata(
			ctx,
			MultilevelSwitchCCValues.levelChangeDown(switchType),
		);
	}
}

// @publicAPI
export interface MultilevelSwitchCCSetOptions {
	targetValue: number;
	// Version >= 2:
	duration?: Duration | string;
}

@CCCommand(MultilevelSwitchCommand.Set)
@useSupervision()
export class MultilevelSwitchCCSet extends MultilevelSwitchCC {
	public constructor(
		options: WithAddress<MultilevelSwitchCCSetOptions>,
	) {
		super(options);
		this.targetValue = options.targetValue;
		this.duration = Duration.from(options.duration);
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): MultilevelSwitchCCSet {
		validatePayload(raw.payload.length >= 1);
		const targetValue = raw.payload[0];
		let duration: Duration | undefined;

		if (raw.payload.length >= 2) {
			duration = Duration.parseReport(raw.payload[1]);
		}

		return new this({
			nodeId: ctx.sourceNodeId,
			targetValue,
			duration,
		});
	}

	public targetValue: number;
	public duration: Duration | undefined;

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([
			this.targetValue,
			(this.duration ?? Duration.default()).serializeSet(),
		]);

		const ccVersion = getEffectiveCCVersion(ctx, this);
		if (
			ccVersion < 2 && ctx.getDeviceConfig?.(
				this.nodeId as number,
			)?.compat?.encodeCCsUsingTargetVersion
		) {
			// When forcing CC version 1, only include the target value
			this.payload = this.payload.subarray(0, 1);
		}

		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		const message: MessageRecord = {
			"target value": this.targetValue,
		};
		if (this.duration) {
			message.duration = this.duration.toString();
		}
		return {
			...super.toLogEntry(ctx),
			message,
		};
	}
}

// @publicAPI
export interface MultilevelSwitchCCReportOptions {
	currentValue?: MaybeUnknown<number>;
	targetValue?: MaybeUnknown<number>;
	duration?: Duration | string;
}

@CCCommand(MultilevelSwitchCommand.Report)
@ccValueProperty("targetValue", MultilevelSwitchCCValues.targetValue)
@ccValueProperty("duration", MultilevelSwitchCCValues.duration)
@ccValueProperty("currentValue", MultilevelSwitchCCValues.currentValue)
export class MultilevelSwitchCCReport extends MultilevelSwitchCC {
	public constructor(
		options: WithAddress<MultilevelSwitchCCReportOptions>,
	) {
		super(options);

		this.currentValue = options.currentValue;
		this.targetValue = options.targetValue;
		this.duration = Duration.from(options.duration);
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): MultilevelSwitchCCReport {
		validatePayload(raw.payload.length >= 1);
		const currentValue: MaybeUnknown<number> | undefined =
			// 0xff is a legacy value for 100% (99)
			raw.payload[0] === 0xff
				? 99
				: parseMaybeNumber(raw.payload[0]);
		let targetValue: MaybeUnknown<number> | undefined;
		let duration: Duration | undefined;

		if (raw.payload.length >= 3) {
			targetValue = parseMaybeNumber(raw.payload[1]);
			duration = Duration.parseReport(raw.payload[2]);
		}

		return new this({
			nodeId: ctx.sourceNodeId,
			currentValue,
			targetValue,
			duration,
		});
	}

	public targetValue: MaybeUnknown<number> | undefined;

	public duration: Duration | undefined;

	public currentValue: MaybeUnknown<number> | undefined;

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([
			this.currentValue ?? 0xfe,
			this.targetValue ?? 0xfe,
			(this.duration ?? Duration.default()).serializeReport(),
		]);
		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		const message: MessageRecord = {
			"current value": maybeUnknownToString(this.currentValue),
		};
		if (this.targetValue !== NOT_KNOWN && this.duration) {
			message["target value"] = maybeUnknownToString(this.targetValue);
			message.duration = this.duration.toString();
		}
		return {
			...super.toLogEntry(ctx),
			message,
		};
	}
}

@CCCommand(MultilevelSwitchCommand.Get)
@expectedCCResponse(MultilevelSwitchCCReport)
export class MultilevelSwitchCCGet extends MultilevelSwitchCC {}

// @publicAPI
export type MultilevelSwitchCCStartLevelChangeOptions =
	& {
		direction: keyof typeof LevelChangeDirection;
	}
	& (
		| {
			ignoreStartLevel: true;
			startLevel?: number;
		}
		| {
			ignoreStartLevel: false;
			startLevel: number;
		}
	)
	& {
		// Version >= 2:
		duration?: Duration | string;
	};

@CCCommand(MultilevelSwitchCommand.StartLevelChange)
@useSupervision()
export class MultilevelSwitchCCStartLevelChange extends MultilevelSwitchCC {
	public constructor(
		options: WithAddress<MultilevelSwitchCCStartLevelChangeOptions>,
	) {
		super(options);
		this.duration = Duration.from(options.duration);
		this.ignoreStartLevel = options.ignoreStartLevel;
		this.startLevel = options.startLevel ?? 0;
		this.direction = options.direction;
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): MultilevelSwitchCCStartLevelChange {
		validatePayload(raw.payload.length >= 2);
		const ignoreStartLevel = !!((raw.payload[0] & 0b0_0_1_00000) >>> 5);
		const direction = ((raw.payload[0] & 0b0_1_0_00000) >>> 6)
			? "down"
			: "up";
		const startLevel = raw.payload[1];
		let duration: Duration | undefined;
		if (raw.payload.length >= 3) {
			duration = Duration.parseSet(raw.payload[2]);
		}

		return new this({
			nodeId: ctx.sourceNodeId,
			ignoreStartLevel,
			direction,
			startLevel,
			duration,
		});
	}

	public duration: Duration | undefined;
	public startLevel: number;
	public ignoreStartLevel: boolean;
	public direction: keyof typeof LevelChangeDirection;

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		const controlByte = (LevelChangeDirection[this.direction] << 6)
			| (this.ignoreStartLevel ? 0b0010_0000 : 0);
		this.payload = Bytes.from([
			controlByte,
			this.startLevel,
			(this.duration ?? Duration.default()).serializeSet(),
		]);

		const ccVersion = getEffectiveCCVersion(ctx, this);
		if (
			ccVersion < 2 && ctx.getDeviceConfig?.(
				this.nodeId as number,
			)?.compat?.encodeCCsUsingTargetVersion
		) {
			// When forcing CC version 1, omit the duration byte
			this.payload = this.payload.subarray(0, -1);
		}

		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		const message: MessageRecord = {
			startLevel: `${this.startLevel}${
				this.ignoreStartLevel ? " (ignored)" : ""
			}`,
			direction: this.direction,
		};
		if (this.duration) {
			message.duration = this.duration.toString();
		}
		return {
			...super.toLogEntry(ctx),
			message,
		};
	}
}

@CCCommand(MultilevelSwitchCommand.StopLevelChange)
@useSupervision()
export class MultilevelSwitchCCStopLevelChange extends MultilevelSwitchCC {}

// @publicAPI
export interface MultilevelSwitchCCSupportedReportOptions {
	switchType: SwitchType;
}

@CCCommand(MultilevelSwitchCommand.SupportedReport)
@ccValueProperty("switchType", MultilevelSwitchCCValues.switchType)
export class MultilevelSwitchCCSupportedReport extends MultilevelSwitchCC {
	public constructor(
		options: WithAddress<MultilevelSwitchCCSupportedReportOptions>,
	) {
		super(options);

		this.switchType = options.switchType;
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): MultilevelSwitchCCSupportedReport {
		validatePayload(raw.payload.length >= 1);
		const switchType: SwitchType = raw.payload[0] & 0b11111;

		return new this({
			nodeId: ctx.sourceNodeId,
			switchType,
		});
	}

	// This is the primary switch type. We're not supporting secondary switch types

	public readonly switchType: SwitchType;

	public persistValues(ctx: PersistValuesContext): boolean {
		if (!super.persistValues(ctx)) return false;
		this.createMetadataForLevelChangeActions(ctx, this.switchType);
		return true;
	}

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([this.switchType & 0b11111]);
		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(ctx),
			message: {
				"switch type": getEnumMemberName(SwitchType, this.switchType),
			},
		};
	}
}

@CCCommand(MultilevelSwitchCommand.SupportedGet)
@expectedCCResponse(MultilevelSwitchCCSupportedReport)
export class MultilevelSwitchCCSupportedGet extends MultilevelSwitchCC {}
