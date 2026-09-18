pub mod activation_cutover;
pub mod bootstrap;
pub mod business_projection;
pub mod canonical;
pub mod causal;
pub mod conflict;
pub mod desktop_lifecycle;
pub mod durable_persistence;
pub mod immutable_publish;
pub mod materialized_projection;
pub mod migration_orchestration;
pub mod ordinary_mutation;
pub mod outbound_completion;
pub mod outbound_freeze;
pub mod outbound_publish;
pub mod remote_discovery;
pub mod root_coordinator;
pub mod semantic;
pub mod target_root_binding;
pub mod types;
pub mod webdav_adapter;

#[cfg(test)]
mod activation_cutover_tests;
#[cfg(test)]
mod causal_tests;
#[cfg(test)]
mod desktop_lifecycle_tests;
#[cfg(test)]
mod durable_persistence_tests;
#[cfg(test)]
mod immutable_publish_tests;
#[cfg(test)]
mod materialized_projection_tests;
#[cfg(test)]
mod migration_orchestration_tests;
#[cfg(test)]
mod ordinary_mutation_tests;
#[cfg(test)]
mod outbound_publish_tests;
#[cfg(test)]
mod remote_discovery_tests;
#[cfg(test)]
mod tests;
