export {
  STEAM_PACKER_HANDOFF_SCHEMA,
  PORTABLE_VERSION_HANDOFF_SCHEMA,
  validateReleasePlan,
  validateReleasePlan as validatePortableVersionHandoff,
  loadReleasePlan,
  loadReleasePlan as loadPortableVersionHandoff
} from './release-plan.mjs';
