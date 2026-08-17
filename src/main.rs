use std::{
    path::{Path, PathBuf},
    process::ExitCode,
};

use clap::{Parser, Subcommand};
use orchestrator_tool::{
    PRODUCT_NAME, VERSION,
    config::Config,
    discovery::{
        ExecutablePathSource, ExecutableStatus, built_in_tool_definitions, current_application_dir,
        resolve_executable_path, validate_executable_path,
    },
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
}

fn dispatch(cli: Cli) -> ExitCode {
    let Cli { config, command } = cli;

    match command {
        CliCommand::Doctor => doctor(config.as_deref()),
        CliCommand::Tools {
            command: ToolsCommand::List,
        } => tools_list(config.as_deref()),
    }
}

fn doctor(_config_path: Option<&Path>) -> ExitCode {
    eprintln!("{PRODUCT_NAME}: doctor is not implemented in P5-A");
    ExitCode::FAILURE
}

fn tools_list(config_path: Option<&Path>) -> ExitCode {
    let config = match config_path {
        Some(path) => match Config::load(path) {
            Ok(config) => config,
            Err(error) => {
                eprintln!("{PRODUCT_NAME}: {error}");
                return ExitCode::FAILURE;
            }
        },
        None => Config::default(),
    };
    let application_dir = match current_application_dir() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{PRODUCT_NAME}: could not determine application directory: {error}");
            return ExitCode::FAILURE;
        }
    };

    for definition in built_in_tool_definitions() {
        let resolved = resolve_executable_path(
            &application_dir,
            &definition,
            config.executable_path(definition.id()),
        );
        let status = match validate_executable_path(resolved.path()) {
            Ok(status) => status,
            Err(error) => {
                eprintln!(
                    "{PRODUCT_NAME}: failed to validate {} executable at {}: {error}",
                    definition.id(),
                    resolved.path().display()
                );
                return ExitCode::FAILURE;
            }
        };

        println!(
            "{}\n  status: {}\n  source: {}\n  path: {}\n",
            definition.id(),
            executable_status_label(status),
            executable_source_label(resolved.source()),
            resolved.path().display()
        );
    }

    ExitCode::SUCCESS
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
}
