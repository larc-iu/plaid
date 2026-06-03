import getpass
from plaid_client import PlaidClient

def main():
    client = PlaidClient.login("http://localhost:8085", input("Username: "), getpass.getpass("Password: "))

    projects = client.projects.list()
    print("Projects:", projects)
    project = client.projects.get(projects[0]["id"])
    print("Project:", project)

    documents = client.projects.list_documents(projects[0]["id"])
    print("Documents:", documents)

    document = client.documents.get(documents[0]["id"], include_body=True)
    print("Document:", document)

if __name__ == '__main__':
    main()