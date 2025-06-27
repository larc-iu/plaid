import stanza
import requests
from client import PlaidClient


def get_client(api_url="http://localhost:8085"):
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
                print("Error when attempting to connect to Plaid API: {}".format(e))
                continue
            with open(f".token", "w") as f:
                f.write(token)
                print("Token valid. Wrote token to .token")
            break
    return PlaidClient(api_url, token)

def main():
    client = get_client()

    def on_event(event_type, event_data):
        print(f"Received event. Type: {event_type}.\nPayload: {event_data}")
        if event_type == "audit-log":
            client.projects.send_message("23f9cb87-c5e0-4081-b389-8e6ba00d6367", "Hello, world!")
    client.projects.listen("23f9cb87-c5e0-4081-b389-8e6ba00d6367", on_event)

    # pipeline = stanza.Pipeline('en')
    # doc = pipeline("When I was a young boy")


if __name__ == '__main__':
    main()