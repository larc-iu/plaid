"""
Base Service Infrastructure

Provides common functionality for Plaid services including authentication,
service registration, and request handling patterns.
"""

import sys
import argparse
import requests
import time
from abc import ABC, abstractmethod
from typing import Dict, Any, Optional, Callable
from .client import PlaidClient


class BaseService(ABC):
    """
    Base class for Plaid services.
    
    Provides common infrastructure like authentication, service registration,
    and lifecycle management that all services need.
    """
    
    def __init__(self, service_id: str, service_name: str, description: str, extras: Dict[str, Any] = dict()):
        """
        Initialize the base service.
        
        Args:
            service_id: Unique identifier for the service (e.g., 'asr:whisper')
            service_name: Human-readable name (e.g., 'Whisper ASR')
            description: Description of the service capabilities
        """
        self.service_id = service_id
        self.service_name = service_name
        self.description = description
        self.extras = extras
        self.client: Optional[PlaidClient] = None
        self.service_registration: Optional[Dict] = None
        self.processing_lock = {"is_processing": False}
    
    @staticmethod
    def get_client(api_url: str):
        """
        Get authenticated Plaid client with token management.
        
        Args:
            api_url: Base URL for the Plaid API
            
        Returns:
            Authenticated PlaidClient instance
        """
        # Import PlaidClient here to avoid circular imports
        import sys
        import os
        try:
            with open(".token", "r") as f:
                token = f.read()
        except FileNotFoundError:
            while True:
                token = input("Enter Plaid API token: ").strip()
                client = PlaidClient(api_url, token)
                try:
                    _ = client.projects.list()
                except requests.exceptions.HTTPError as e:
                    print(f"Error when attempting to connect to Plaid API: {e}")
                    continue
                with open(".token", "w") as f:
                    f.write(token)
                    print("Token valid. Wrote token to .token")
                break
        return PlaidClient(api_url, token)
    
    @abstractmethod
    def process_request(self, request_data: Dict[str, Any], response_helper) -> None:
        """
        Process a service request.
        
        Args:
            request_data: Dictionary containing request parameters
            response_helper: Helper object for sending progress updates and results
        """
        pass
    
    @abstractmethod
    def create_argument_parser(self) -> argparse.ArgumentParser:
        """
        Create argument parser for command line options.
        
        Returns:
            ArgumentParser with service-specific arguments
        """
        pass
    
    def setup_parser_common_args(self, parser: argparse.ArgumentParser) -> None:
        """
        Add common arguments to the parser.
        
        Args:
            parser: ArgumentParser to add arguments to
        """
        parser.add_argument('project_id', help='Target project ID')
        parser.add_argument('--url', default='http://localhost:8085', 
                          help='Plaid API URL (default: http://localhost:8085)')
    
    def handle_service_request(self, request_data: Dict[str, Any], response_helper) -> None:
        """
        Handle structured service request with processing lock.
        
        Args:
            request_data: Dictionary containing request parameters
            response_helper: Helper object for sending progress updates and results
        """
        # Check if another request is already being processed
        if self.processing_lock["is_processing"]:
            response_helper.error(
                f"{self.service_name} is currently processing another request. Please try again later."
            )
            return
        
        # Set processing lock before starting
        self.processing_lock["is_processing"] = True
        
        try:
            self.process_request(request_data, response_helper)
        except Exception as e:
            import traceback
            print(f"Error during {self.service_name} processing: {str(e)}")
            response_helper.error(f"{self.service_name} processing error: {str(e)}")
            traceback.print_exc()
        finally:
            # Always clear the processing lock when done
            self.processing_lock["is_processing"] = False
    
    def register_service(self, project_id: str) -> None:
        """
        Register the service with Plaid.
        
        Args:
            project_id: Project ID to register service for
        """
        service_info = {
            'serviceId': self.service_id,
            'serviceName': self.service_name,
            'description': self.description,
            'extras': self.extras
        }
        
        print(f"Registering as service: {service_info}")
        print(f"Starting {self.service_name}, listening to project {project_id}")
        
        self.service_registration = self.client.messages.serve(
            project_id, service_info, self.handle_service_request
        )
        
        print("Service registered successfully. Waiting for requests...")
        print("Press Ctrl+C to stop the service.")
    
    def run_service_loop(self) -> None:
        """
        Run the main service loop until interrupted.
        """
        try:
            # Keep the service running
            while self.service_registration['isRunning']():
                time.sleep(1)
        except KeyboardInterrupt:
            print(f"\\nStopping {self.service_name}...")
            self.service_registration['stop']()
            print("Service stopped.")
    
    def run(self, args=None) -> None:
        """
        Main entry point for running the service.
        
        Args:
            args: Optional command line arguments (uses sys.argv if None)
        """
        # Parse arguments
        parser = self.create_argument_parser()
        parsed_args = parser.parse_args(args)
        
        # Initialize client
        self.client = self.get_client(parsed_args.url)
        self.client.set_agent_name(self.service_name)

        # Setup service-specific configuration
        self.setup(parsed_args)
        
        # Register and run service
        self.register_service(parsed_args.project_id)
        self.run_service_loop()
    
    def setup(self, args) -> None:
        """
        Setup service-specific configuration.
        
        Override this method to handle service-specific setup after
        argument parsing but before service registration.
        
        Args:
            args: Parsed command line arguments
        """
        pass