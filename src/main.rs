use std::{
    path::{Path, PathBuf},
    process::ExitCode,
};

use clap::{Parser, Subcommand};
use orchestrator_tool::{PRODUCT_NAME, VERSION};

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

fn tools_list(_config_path: Option<&Path>) -> ExitCode {
    eprintln!("{PRODUCT_NAME}: tools list is not implemented in P5-A");
    ExitCode::FAILURE
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
