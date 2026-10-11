import type {
	CompanionStaticUpgradeProps,
	CompanionStaticUpgradeResult,
	CompanionStaticUpgradeScript,
	CompanionUpgradeContext,
} from '@companion-module/base'
import type { ModuleConfig, ModuleSecrets } from './config.js'

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig, ModuleSecrets>[] = [
	/*
	 * Place your upgrade scripts here
	 * Remember that once it has been added it cannot be removed!
	 */
	// The station token moves from the plain config into the secrets store (kept out of exports).
	function (
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, ModuleSecrets>,
	): CompanionStaticUpgradeResult<ModuleConfig, ModuleSecrets> {
		const token = props.config?.token
		if (!props.config || !token) return { updatedConfig: null, updatedActions: [], updatedFeedbacks: [] }
		const { token: _moved, ...config } = props.config
		return {
			updatedConfig: config,
			updatedSecrets: { ...(props.secrets ?? {}), token },
			updatedActions: [],
			updatedFeedbacks: [],
		}
	},
]
