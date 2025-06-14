from client import PlaidClient
import getpass

def main():
    client = PlaidClient.login("http://localhost:8085", input("Username: "), getpass.getpass("Password: "))

    projects = client.projects.list()
    print("Projects:", projects)
    project = client.projects.get(projects[0]["id"], include_documents=True)
    print("Project:", project)

    document = client.documents.get(project["documents"][0]["id"], include_body=True)
    print("Document:", document)

if __name__ == '__main__':
    main()