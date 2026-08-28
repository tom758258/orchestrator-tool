use std::{
    path::{Path, PathBuf},
    process::ExitCode,
};

use clap::{Parser, Subcommand};
use orchestrator_tool::{
    PRODUCT_NAME, VERSION,
    config::{Config, ConfigError},
    discovery::{
        ExecutablePathSource, ExecutableStatus, built_in_tool_definitions, current_application_dir,
    },
    inspection::{inspect_built_in_tools, inspect_tool},
    manifest::WorkerCompatibility,
    manifest_probe::probe_manifest,
    tool::ToolId,
};

/// Coordinates external instrument tools.
#[derive(Debug, Parser)]
#[command(name = PRODUCT_NAME, version = VERSION)]
struct Cli {
    /// Path to the orchestrator configuration file.
    #[arg(long, global = true, value_name = "PATH")]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: CliCommand,
}

#[derive(Debug, Subcommand)]
enum CliCommand {
    /// Checks the orchestrator environment.
    Doctor,
    /// Manages external tools.
    Tools {
        #[command(subcommand)]
        command: ToolsCommand,
    },
}

#[derive(Debug, Subcommand)]
enum ToolsCommand {
    /// Lists external tools.
    List,
    /// Inspects a single external tool.
    Inspect {
        /// Tool ID to inspect.
        tool_id: String,
    },
}

fn dispatch(cli: Cli) -> ExitCode {
    let Cli { config, command } = cli;

    match command {
        CliCommand::Doctor => doctor(config.as_deref()),
        CliCommand::Tools {
            command: ToolsCommand::List,
        } => tools_list(config.as_deref()),
        CliCommand::Tools {
            command: ToolsCommand::Inspect { tool_id },
        } => tools_inspect(config.as_deref(), &tool_id),
    }
}

fn doctor(config_path: Option<&Path>) -> ExitCode {
    let config = match load_config(config_path) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{PRODUCT_NAME}: {error}");
            return ExitCode::FAILURE;
        }
    };
    let application_dir = match current_application_dir() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{PRODUCT_NAME}: could not determine application directory: {error}");
            return ExitCode::FAILURE;
        }
    };

    println!("{PRODUCT_NAME} {VERSION}\n");

    println!("Application");
    println!("  directory: {}", application_dir.display());
    println!("  status: ok\n");

    println!("Configuration");
    match config_path {
        Some(path) => {
            println!("  path: {}", path.display());
            println!("  status: ok\n");
        }
        None => println!("  status: not specified\n"),
    }

    println!("External tools");
    let mut available = 0;
    let mut missing = 0;
    let mut not_file = 0;

    let inspections = match inspect_built_in_tools(&application_dir, &config) {
        Ok(inspections) => inspections,
        Err(error) => {
            eprintln!("{PRODUCT_NAME}: {error}");
            return ExitCode::FAILURE;
        }
    };

    for inspection in &inspections {
        let status = inspection.status();

        match status {
            ExecutableStatus::Available => available += 1,
            ExecutableStatus::Missing => missing += 1,
            ExecutableStatus::NotFile => not_file += 1,
        }
        println!(
            "  {:<11}{}",
            doctor_status_label(status),
            inspection.resolved().tool_id()
        );
    }

    println!("\nSummary");
    println!("  available: {available}");
    println!("  missing: {missing}");
    println!("  not-file: {not_file}");

    ExitCode::SUCCESS
}

fn load_config(config_path: Option<&Path>) -> Result<Config, ConfigError> {
    match config_path {
        Some(path) => Config::load(path),
        None => Ok(Config::default()),
    }
}

fn tools_list(config_path: Option<&Path>) -> ExitCode {
    let config = match load_config(config_path) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{PRODUCT_NAME}: {error}");
            return ExitCode::FAILURE;
        }
    };
    let application_dir = match current_application_dir() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{PRODUCT_NAME}: could not determine application directory: {error}");
            return ExitCode::FAILURE;
        }
    };

    let inspections = match inspect_built_in_tools(&application_dir, &config) {
        Ok(inspections) => inspections,
        Err(error) => {
            eprintln!("{PRODUCT_NAME}: {error}");
            return ExitCode::FAILURE;
        }
    };

    for inspection in &inspections {
        println!(
            "{}\n  status: {}\n  source: {}\n  path: {}\n",
            inspection.resolved().tool_id(),
            executable_status_label(inspection.status()),
            executable_source_label(inspection.resolved().source()),
            inspection.resolved().path().display()
        );
    }

    ExitCode::SUCCESS
}

fn tools_inspect(config_path: Option<&Path>, raw_tool_id: &str) -> ExitCode {
    let tool_id = match ToolId::new(raw_tool_id) {
        Ok(id) => id,
        Err(error) => {
            eprintln!("{PRODUCT_NAME}: invalid tool ID {raw_tool_id:?}: {error}");
            return ExitCode::FAILURE;
        }
    };

    let definition = match built_in_tool_definitions()
        .into_iter()
        .find(|definition| definition.id() == &tool_id)
    {
        Some(definition) => definition,
        None => {
            eprintln!("{PRODUCT_NAME}: unknown tool ID {tool_id}");
            return ExitCode::FAILURE;
        }
    };

    let config = match load_config(config_path) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{PRODUCT_NAME}: {error}");
            return ExitCode::FAILURE;
        }
    };

    let application_dir = match current_application_dir() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{PRODUCT_NAME}: could not determine application directory: {error}");
            return ExitCode::FAILURE;
        }
    };

    let inspection = match inspect_tool(&application_dir, &config, &definition) {
        Ok(inspection) => inspection,
        Err(error) => {
            eprintln!("{PRODUCT_NAME}: {error}");
            return ExitCode::FAILURE;
        }
    };

    println!("{}", inspection.resolved().tool_id());
    println!();
    println!("  executable");
    println!(
        "    status: {}",
        executable_status_label(inspection.status())
    );
    println!(
        "    source: {}",
        executable_source_label(inspection.resolved().source())
    );
    println!("    path: {}", inspection.resolved().path().display());
    println!();

    if inspection.status() != ExecutableStatus::Available {
        println!("  manifest");
        println!("    status: not-probed");
        return ExitCode::SUCCESS;
    }

    match probe_manifest(inspection.resolved().path(), &tool_id) {
        Ok(probe) => {
            println!("  manifest");
            println!("    tool-id: {}", probe.manifest().tool_id());
            println!("    tool-version: {}", probe.manifest().tool_version());
            println!("    schema-version: {}", probe.manifest().schema_version());
            println!();
            println!("  worker-protocol");
            println!(
                "    policy: {}",
                probe.manifest().worker_protocol().compatibility_policy()
            );
            let versions = probe
                .manifest()
                .worker_protocol()
                .schema_versions()
                .iter()
                .map(|version| version.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            println!("    schema-versions: {versions}");
            println!();
            let compatibility = probe.manifest().worker_compatibility();
            let label = if compatibility == WorkerCompatibility::Compatible {
                "compatible"
            } else {
                "incompatible"
            };
            println!("  compatibility: {label}");

            let stderr = probe.stderr().trim();
            if !stderr.is_empty() {
                println!();
                println!("  manifest stderr:");
                println!("    {stderr}");
            }

            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("  manifest");
            println!("    status: error");
            println!("    reason: {error}");
            ExitCode::FAILURE
        }
    }
}

fn executable_status_label(status: ExecutableStatus) -> &'static str {
    match status {
        ExecutableStatus::Available => "available",
        ExecutableStatus::Missing => "missing",
        ExecutableStatus::NotFile => "not-file",
    }
}

fn executable_source_label(source: ExecutablePathSource) -> &'static str {
    match source {
        ExecutablePathSource::Configured => "configured",
        ExecutablePathSource::Portable => "portable",
    }
}

fn doctor_status_label(status: ExecutableStatus) -> &'static str {
    match status {
        ExecutableStatus::Available => "[OK]",
        ExecutableStatus::Missing => "[MISSING]",
        ExecutableStatus::NotFile => "[NOT-FILE]",
    }
}

fn main() -> ExitCode {
    dispatch(Cli::parse())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use clap::Parser;

    use super::{Cli, CliCommand, ToolsCommand};

    #[test]
    fn doctor_command_parses() {
        let cli = Cli::try_parse_from(["orchestrator-tool", "doctor"]).unwrap();

        assert!(cli.config.is_none());
        assert!(matches!(cli.command, CliCommand::Doctor));
    }

    #[test]
    fn doctor_command_parses_with_config() {
        let cli = Cli::try_parse_from(["orchestrator-tool", "--config", "example.toml", "doctor"])
            .unwrap();

        assert_eq!(cli.config.as_deref(), Some(Path::new("example.toml")));
        assert!(matches!(cli.command, CliCommand::Doctor));
    }

    #[test]
    fn tools_list_command_parses() {
        let cli = Cli::try_parse_from(["orchestrator-tool", "tools", "list"]).unwrap();

        assert!(cli.config.is_none());
        assert!(matches!(
            cli.command,
            CliCommand::Tools {
                command: ToolsCommand::List
            }
        ));
    }

    #[test]
    fn tools_list_command_parses_with_config() {
        let cli = Cli::try_parse_from([
            "orchestrator-tool",
            "--config",
            "example.toml",
            "tools",
            "list",
        ])
        .unwrap();

        assert_eq!(cli.config.as_deref(), Some(Path::new("example.toml")));
        assert!(matches!(
            cli.command,
            CliCommand::Tools {
                command: ToolsCommand::List
            }
        ));
    }

    #[test]
    fn tools_inspect_command_parses() {
        let cli = Cli::try_parse_from(["orchestrator-tool", "tools", "inspect", "meters"]).unwrap();

        assert!(cli.config.is_none());
        match cli.command {
            CliCommand::Tools {
                command: ToolsCommand::Inspect { tool_id },
            } => assert_eq!(tool_id, "meters"),
            _ => panic!("unexpected command"),
        }
    }
}
